import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownMessageProps {
  text: string;
  streaming?: boolean;
  variant?: 'default' | 'on-dark';
}

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <pre className="markdown-pre">{children}</pre>,
  code: ({ className, children }) => {
    const isBlock = Boolean(className);
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return <code className="markdown-inline-code">{children}</code>;
  },
};

export function MarkdownMessage({
  text,
  streaming = false,
  variant = 'default',
}: MarkdownMessageProps) {
  if (streaming) {
    return <p className="whitespace-pre-wrap break-words">{text}</p>;
  }

  return (
    <div
      className={`markdown-body break-words${variant === 'on-dark' ? ' markdown-body-on-dark' : ''}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
