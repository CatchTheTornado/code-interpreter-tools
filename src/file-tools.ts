import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';

interface Tool {
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: any) => Promise<any>;
}

function resolveWithinRoot(rootDir: string, relativePath: string): string {
  const resolved = path.resolve(rootDir, relativePath);
  // Ensure the resolved path stays within the rootDir
  if (!resolved.startsWith(path.resolve(rootDir))) {
    throw new Error('Attempt to access path outside root directory');
  }
  return resolved;
}

export function createFileTools(rootDir: string) {
  // Schema for creating file structure
  const fileSchema = z.object({
    path: z.string().describe('Relative path of the file to create within the workspace.'),
    content: z.string().describe('Content to write into the file.'),
    description: z.string().optional().describe('Optional human-friendly description of what this file does.')
  }).describe('Single file definition');

  const createStructureSchema = z.object({
    structure: z.object({
      // Files to create inside the root directory
      files: z.array(fileSchema).optional().default([]).describe('Array of files to create.'),
      // Directories (relative paths) to create even if they contain no files
      dirs: z.array(z.string()).optional().default([]).describe('Array of empty directory paths to create.'),
      // Any package dependencies required by the structure (metadata only)
      dependencies: z.array(z.string()).optional().describe('Optional list of package/runtime dependencies required by this project')
    }).describe('File/folder structure specification')
  }).describe('Arguments for createFileStructureTool');

  const writeFileSchema = z.object({
    path: z.string().describe('Relative path of the file to write.'),
    content: z.string().describe('Content to write into the file.')
  }).describe('Arguments for writeFileTool');

  const readFileSchema = z.object({
    path: z.string().describe('Relative path of the file to read.')
  }).describe('Arguments for readFileTool');

  const listFilesSchema = z.object({
    path: z.string().optional().describe('Relative directory path to list (defaults to workspace root)')
  }).describe('Arguments for listFilesTool');

  const createFileStructureTool: Tool = {
    description: 'Creates a structure of files and directories based on the provided JSON object.',
    parameters: createStructureSchema,
    execute: async ({ structure }: z.infer<typeof createStructureSchema>): Promise<{ stdout: string; generatedFiles: string[]; createdDirs: string[]; dependencies?: string[] }> => {
      const generatedFiles: string[] = [];
      const createdDirs: string[] = [];

      // Ensure directories (explicit or from file paths) exist
      const ensureDir = (dirRelPath: string) => {
        const absDir = resolveWithinRoot(rootDir, dirRelPath);
        if (!fs.existsSync(absDir)) {
          fs.mkdirSync(absDir, { recursive: true });
          createdDirs.push(dirRelPath.endsWith('/') ? dirRelPath : dirRelPath + '/');
        }
      };

      // First create explicit empty directories
      for (const dir of structure.dirs ?? []) {
        ensureDir(dir);
      }

      // Then process files
      for (const file of structure.files ?? []) {
        const filePath = resolveWithinRoot(rootDir, file.path);
        const dirPath = path.dirname(filePath);
        ensureDir(path.relative(rootDir, dirPath));
        fs.writeFileSync(filePath, file.content);
        generatedFiles.push(file.path);
      }

      const summaryLines: string[] = [];
      if (createdDirs.length > 0) summaryLines.push(`Created ${createdDirs.length} directories`, ...createdDirs);
      if (generatedFiles.length > 0) summaryLines.push(`Generated ${generatedFiles.length} files`, ...generatedFiles);

      return {
        stdout: summaryLines.join('\n'),
        generatedFiles,
        createdDirs,
        dependencies: structure.dependencies ?? []
      };
    }
  } as Tool;

  const writeFileTool: Tool = {
    description: 'Writes content to a file within the root directory.',
    parameters: writeFileSchema,
    execute: async ({ path: filePath, content }: z.infer<typeof writeFileSchema>): Promise<{ stdout: string }> => {
      const resolved = resolveWithinRoot(rootDir, filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content);
      return { stdout: `Wrote file ${filePath}` };
    }
  };

  const readFileTool: Tool = {
    description: 'Reads a file within the root directory and returns its content.',
    parameters: readFileSchema,
    execute: async ({ path: filePath }: z.infer<typeof readFileSchema>): Promise<{ stdout: string }> => {
      const resolved = resolveWithinRoot(rootDir, filePath);
      const content = fs.readFileSync(resolved, 'utf8');
      return { stdout: content };
    }
  };

  const listFilesTool: Tool = {
    description: 'Lists all files and directories within a given path relative to the root directory.',
    parameters: listFilesSchema,
    execute: async ({ path: dir = '.' }: z.infer<typeof listFilesSchema>): Promise<{ stdout: string }> => {
      const resolvedDir = resolveWithinRoot(rootDir, dir);
      function walk(currentDir: string, base = ''): string[] {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        const results: string[] = [];
        for (const entry of entries) {
          const relPath = path.join(base, entry.name);
          if (entry.isDirectory()) {
            results.push(relPath + '/');
            results.push(...walk(path.join(currentDir, entry.name), relPath));
          } else {
            results.push(relPath);
          }
        }
        return results;
      }
      const files = walk(resolvedDir);
      return { stdout: files.join('\n') };
    }
  };

  return {
    createFileStructureTool,
    writeFileTool,
    readFileTool,
    listFilesTool
  };
} 