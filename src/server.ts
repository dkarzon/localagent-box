import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { getServerEnv } from './config/env';
import { sendJson, parseUrl, MIME_TYPES } from './lib/http';
import { handleRouteError } from './lib/error-handler';
import { isDefaultApiToken } from './lib/auth';
import { getLogger } from './lib/logger';
import { registerProcessHandlers } from './lib/process-handlers';
import { createConfigRepository } from './domains/config/config.repository';
import { createJsonStore } from './lib/json-store';
import { createOpenCodeConfigService } from './services/opencode-config';
import { createOllamaProbe } from './services/ollama-probe';
import { createOllamaChat } from './services/ollama-client';
import { createGithubAppService } from './services/github-app';
import { createGitService } from './services/git-service';
import { createRepoService } from './domains/repos/repo.service';
import { createAgentService } from './domains/agents/agent.service';
import healthRoute from './routes/health';
import configRoute from './routes/config';
import githubRoute from './routes/github';
import reposRoute from './routes/repos';
import agentsRoute from './routes/agents';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Agent, OllamaProbeResult, Repo, Route, ServerContext } from './types';

const routes: Route[] = [healthRoute, configRoute, githubRoute, reposRoute, agentsRoute];

function ensureDirectories(env: ReturnType<typeof getServerEnv>): void {
  fs.mkdirSync(`${env.dataDir}/agents`, { recursive: true });
  fs.mkdirSync(env.agentWorkspace, { recursive: true });
}

function bootstrapConfig(
  configRepository: ReturnType<typeof createConfigRepository>,
  env: ReturnType<typeof getServerEnv>,
) {
  const current = configRepository.load();

  if (env.ollamaBaseUrl && !current.ollamaBaseUrl) {
    return configRepository.save({
      ollamaBaseUrl: env.ollamaBaseUrl,
      opencodeModel: env.opencodeModel || current.opencodeModel,
      opencodeProvider: env.opencodeProvider || current.opencodeProvider,
    });
  }

  return current;
}

function createContext(env: ReturnType<typeof getServerEnv>): ServerContext {
  const configRepository = createConfigRepository(env.dataDir, fs);
  const reposStore = createJsonStore<{ repos: Repo[] }>(`${env.dataDir}/repos.json`, { repos: [] }, fs);
  const agentsStore = createJsonStore<{ agents: Agent[] }>(`${env.dataDir}/agents.json`, { agents: [] }, fs);
  const opencodeConfig = createOpenCodeConfigService();
  const ollamaProbe = createOllamaProbe();
  const ollamaChat = createOllamaChat();
  const githubApp = createGithubAppService();
  const gitService = createGitService({ githubApp, workspaceRoot: env.agentWorkspace });
  const repoManager = createRepoService({ reposStore, githubApp, gitService });

  const config = bootstrapConfig(configRepository, env);

  const agentManager = createAgentService({
    dataDir: env.dataDir,
    agentsStore,
    repoManager,
    configRepository,
    githubApp,
    gitService,
    ollamaChat,
    workspaceRoot: env.agentWorkspace,
    maxConcurrent: env.maxConcurrentAgents,
    agentTimeoutMs: env.agentTimeoutMs,
    interactiveAgentTimeoutFallbackSeconds: env.agentTimeoutSeconds,
    loopAgentTimeoutFallbackSeconds: env.agentTimeoutSeconds,
  });

  agentManager.restoreOnStartup();

  if (!fs.existsSync(`${env.dataDir}/repos.json`)) {
    reposStore.save({ repos: [] });
  }
  if (!fs.existsSync(`${env.dataDir}/agents.json`)) {
    agentsStore.save({ agents: [] });
  }

  if (config.ollamaBaseUrl) {
    opencodeConfig.writeOpenCodeConfig(config);
  }

  if (config.gitUserName || config.gitUserEmail) {
    gitService.applyGitConfig(config);
  }

  return {
    configStore: {
      loadConfig: () => configRepository.load(),
      saveConfig: (partial) => configRepository.save(partial),
      toPublicConfig: (cfg) => configRepository.toPublic(cfg),
    },
    configRepository,
    reposStore,
    agentsStore,
    opencodeConfig,
    ollamaProbe,
    ollamaChat,
    githubApp,
    gitService,
    repoManager,
    agentManager,
  };
}

function serveStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  publicDir: string,
): boolean {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return true;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const indexPath = path.join(publicDir, 'index.html');
    if (path.extname(pathname) === '' && fs.existsSync(indexPath)) {
      const body = fs.readFileSync(indexPath);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
      });
      res.end(body);
      return true;
    }
    return false;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
  });
  res.end(body);
  return true;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
  publicDir: string,
): Promise<void> {
  const requestId = crypto.randomUUID();
  const { pathname } = parseUrl(req);
  const log = getLogger().child({ requestId, method: req.method, path: pathname });

  try {
    for (const route of routes) {
      if (route.match(req.method, pathname)) {
        await route.handle(req, res, ctx);
        log.debug({ statusCode: res.statusCode }, 'request handled');
        return;
      }
    }

    if (req.method === 'GET' && serveStatic(req, res, pathname, publicDir)) {
      log.debug({ statusCode: res.statusCode }, 'static asset served');
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
    log.debug({ statusCode: 404 }, 'request not found');
  } catch (err) {
    log.error({ err }, 'request failed');
    handleRouteError(res, err);
  }
}

function setupGracefulShutdown(
  server: http.Server,
  ctx: ServerContext,
  env: ReturnType<typeof getServerEnv>,
): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const log = getLogger();
    log.info({ signal }, 'Shutdown initiated');

    const forceTimer = setTimeout(() => {
      log.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, env.shutdownTimeoutMs);
    forceTimer.unref();

    server.close(() => {
      log.info('HTTP server stopped accepting connections');
    });

    ctx.agentManager
      .shutdown()
      .then(() => {
        clearTimeout(forceTimer);
        log.info('Shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        log.error({ err }, 'Error during shutdown');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function startServer(): void {
  const env = getServerEnv();
  const logger = getLogger();

  registerProcessHandlers(logger);
  ensureDirectories(env);

  const ctx = createContext(env);

  if (isDefaultApiToken()) {
    logger.warn('API_TOKEN not set; using default token (set API_TOKEN in production)');
  }

  ctx.ollamaProbe.probe(ctx.configRepository.load().ollamaBaseUrl).then((ollama: OllamaProbeResult) => {
    if (ollama.status === 'not_configured') {
      logger.warn('Ollama URL not configured (set ollamaBaseUrl via API/UI or OLLAMA_BASE_URL env)');
    } else if (!ollama.reachable) {
      logger.warn({ url: ollama.url, message: ollama.message }, 'Ollama unreachable');
    } else {
      logger.info({ url: ollama.url, modelCount: ollama.modelCount }, 'Ollama reachable');
    }
  });

  const server = http.createServer((req, res) => {
    handleRequest(req, res, ctx, env.publicDir).catch((err) => {
      logger.error({ err }, 'Unhandled request error');
      handleRouteError(res, err);
    });
  });

  setupGracefulShutdown(server, ctx, env);

  server.listen(env.port, '0.0.0.0', () => {
    logger.info({ port: env.port }, 'Local Agent Box listening');
  });
}

startServer();
