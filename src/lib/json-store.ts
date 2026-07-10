export interface JsonStore<T> {
  load: () => T;
  save: (value: T) => void;
}

type FsLike = Pick<typeof import('fs'), 'readFileSync' | 'writeFileSync'>;

export function createJsonStore<T>(filePath: string, defaultValue: T, fs: FsLike): JsonStore<T> {
  function load(): T {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
        return defaultValue;
      }
      throw err;
    }
  }

  function save(value: T): void {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  return { load, save };
}
