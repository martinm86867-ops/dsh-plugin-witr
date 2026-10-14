declare module 'node:child_process' {
  export function execFile(...args: any[]): any
}
declare module 'node:util' {
  export function promisify(...args: any[]): any
}
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(options: any): any
}
declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: {
      register(tool: any): void
    }
  }
}
declare module '@deepseek-ai/schemastery' {
  interface Schema<T = any> {
    [key: string]: any
  }
  const Schema: {
    object(spec: any): any
    string(): any
    number(): any
    [key: string]: any
  }
  export default Schema
  export type { Schema }
}
