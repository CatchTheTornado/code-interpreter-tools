export type Language = 'typescript' | 'javascript' | 'python' | 'shell'; // default languages

export interface ExecutionOptions {
  language: Language;
  code: string;
  dependencies?: string[];
  timeout?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  verbose?: boolean;
  runApp?: {
    cwd: string;
    entryFile: string;  // Path to the entry file relative to the mounted directory
  };
  streamOutput?: {
    stdout?: (data: string) => void;
    stderr?: (data: string) => void;
    dependencyStdout?: (data: string) => void;
    dependencyStderr?: (data: string) => void;
  };
  workspaceSharing?: 'isolated' | 'shared';  // New option: 'isolated' (default) or 'shared'
}

export interface MountOptions {
  type: 'file' | 'directory' | 'zip';
  source: string;
  target: string;
}

export interface ContainerConfig {
  image: string;
  mounts?: MountOptions[];
  environment?: Record<string, string>;
  name?: string;
  ports?: number[]; // Host ports to publish (TCP)
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  dependencyStdout: string;
  dependencyStderr: string;
  exitCode: number;
  executionTime: number;
  workspaceDir: string;
  generatedFiles: string[];
  sessionGeneratedFiles: string[]; // All files generated across all runs in the session
}

export interface ContainerPoolConfig {
  maxSize: number;
  minSize: number;
  idleTimeout: number;
}

export enum ContainerStrategy {
  PER_EXECUTION = 'per_execution',
  POOL = 'pool',
  PER_SESSION = 'per_session'
}

export interface SessionConfig {
  strategy: ContainerStrategy;
  poolConfig?: ContainerPoolConfig;
  containerConfig: ContainerConfig;
  sessionId?: string;
  enforceNewSession?: boolean;
}

export interface ContainerMount {
  type: 'directory';
  source: string;
  target: string;
} 