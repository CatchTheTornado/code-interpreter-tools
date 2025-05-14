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

export function createFileTools(
  rootDir: string,
  mapContainerPaths: Record<string, string> = {}
) {
  // Helper that maps an incoming (possibly container) path to a path relative to
  // rootDir based on the provided mapping. If no mapping matches, the original
  // path is returned unchanged.
  const mapPath = (incomingPath: string): string => {
    // Normalise to posix for reliable prefix comparison
    const normIncoming = path.posix.normalize(incomingPath);

    for (const [containerPrefixRaw, localPrefixRaw] of Object.entries(mapContainerPaths)) {
      // Normalise prefixes and ensure trailing slashes are removed for comparison
      const containerPrefix = path.posix.normalize(containerPrefixRaw).replace(/\/$/, '');

      if (normIncoming === containerPrefix || normIncoming.startsWith(containerPrefix + '/')) {
        let rest = normIncoming.slice(containerPrefix.length);
        // Remove leading slash so rest is always relative
        if (rest.startsWith('/')) rest = rest.slice(1);

        const localPrefix = path.posix.normalize(localPrefixRaw);
        // path.posix.join will handle redundant slashes; ensures the result is not absolute
        const mapped = path.posix.join(localPrefix, rest);
        return mapped;
      }
    }
    return incomingPath; // no mapping applicable
  };

  // Wrapper around resolveWithinRoot that first applies path mapping logic
  const resolvePathWithinRoot = (p: string): string => {
    const mapped = mapPath(p);

    // If the mapped path is absolute, ensure it's within rootDir and convert to relative
    if (path.isAbsolute(mapped)) {
      const abs = path.resolve(mapped);
      const rootAbs = path.resolve(rootDir);
      if (!abs.startsWith(rootAbs)) {
        throw new Error('Attempt to access path outside root directory');
      }
      const rel = path.relative(rootAbs, abs);
      return resolveWithinRoot(rootDir, rel);
    }

    // Otherwise treat as relative directly
    return resolveWithinRoot(rootDir, mapped);
  };

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
    execute: async ({ structure }: z.infer<typeof createStructureSchema>): Promise<{ files: Array<{ path: string; description?: string }>; dirs: string[]; summary: string; dependencies?: string[] }> => {
      const generatedFiles: Array<{ path: string; description?: string }> = [];
      const createdDirs: string[] = [];

      // Ensure directories (explicit or from file paths) exist
      const ensureDir = (dirRelPath: string) => {
        const absDir = resolvePathWithinRoot(dirRelPath);
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
        const filePath = resolvePathWithinRoot(file.path);
        const dirPath = path.dirname(filePath);
        ensureDir(path.relative(rootDir, dirPath));
        fs.writeFileSync(filePath, file.content);
        generatedFiles.push({ path: file.path, description: file.description });
      }

      const summaryLines: string[] = [];
      if (createdDirs.length > 0) summaryLines.push(`Created ${createdDirs.length} directories`, ...createdDirs);
      if (generatedFiles.length > 0) summaryLines.push(`Generated ${generatedFiles.length} files`, ...generatedFiles.map(f=>f.path));

      return {
        files: generatedFiles,
        dirs: createdDirs,
        summary: summaryLines.join('\n'),
        dependencies: structure.dependencies ?? []
      };
    }
  } as Tool;

  const writeFileTool: Tool = {
    description: 'Writes content to a file within the root directory and returns basic info about the operation.',
    parameters: writeFileSchema,
    execute: async ({ path: filePath, content }: z.infer<typeof writeFileSchema>): Promise<{ written: string }> => {
      const resolved = resolvePathWithinRoot(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content);
      return { written: filePath };
    }
  };

  const readFileTool: Tool = {
    description: 'Reads a file within the root directory and returns its content encoded in base64.',
    parameters: readFileSchema,
    execute: async ({ path: filePath }: z.infer<typeof readFileSchema>): Promise<{ contentBase64: string }> => {
      const resolved = resolvePathWithinRoot(filePath);
      const buffer = fs.readFileSync(resolved);
      return { contentBase64: buffer.toString('base64') };
    }
  };

  const listFilesTool: Tool = {
    description: 'Lists all files and directories within a given path relative to the root directory.',
    parameters: listFilesSchema,
    execute: async ({ path: dir = '.' }: z.infer<typeof listFilesSchema>): Promise<{ files: string[] }> => {
      const resolvedDir = resolvePathWithinRoot(dir);
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
      return { files };
    }
  };

  return {
    createFileStructureTool,
    writeFileTool,
    readFileTool,
    listFilesTool
  };
} 