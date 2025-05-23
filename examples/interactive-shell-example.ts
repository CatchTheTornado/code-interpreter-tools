import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createCodeExecutionTool, getImageForLanguage } from '../src/code-execution-tool';
import { v4 as uuidv4 } from 'uuid';
import { ContainerStrategy } from '../src/types';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { createFileTools } from '../src/file-tools';

// Simple spinner animation
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: NodeJS.Timeout;

// Command history interface
interface CommandHistory {
  input: string;
  executionInfo?: any;
  output?: {
    stdout?: string;
    stderr?: string;
    generatedFiles?: string[];
  };
  error?: string;
  timestamp: Date;
}

function startSpinner(message: string) {
  let i = 0;
  process.stdout.write('\r' + message + ' ' + spinner[0]);
  spinnerInterval = setInterval(() => {
    process.stdout.write('\r' + message + ' ' + spinner[i]);
    i = (i + 1) % spinner.length;
  }, 80);
}

function stopSpinner(success: boolean, message: string) {
  clearInterval(spinnerInterval);
  process.stdout.write('\r' + (success ? '✓' : '✗') + ' ' + message + '\n');
}

// Function to format history for AI context
function formatHistoryForAI(history: CommandHistory[]): string {
  return history.map(entry => {
    let formatted = `Command: ${entry.input}\n`;
    if (entry.executionInfo) {
      formatted += `Execution Details:\n`;
      if (entry.executionInfo.runApp) {
        formatted += `- Application: ${entry.executionInfo.runApp.entryFile}\n`;
        formatted += `- Working directory: ${entry.executionInfo.runApp.cwd}\n`;
      } else {
        formatted += `- Language: ${entry.executionInfo.language}\n`;
        if (entry.executionInfo.dependencies?.length > 0) {
          formatted += `- Dependencies: ${entry.executionInfo.dependencies.join(', ')}\n`;
        }
        formatted += `- Code:\n\`\`\`${entry.executionInfo.language}\n${entry.executionInfo.code}\n\`\`\`\n`;
      }
    }
    if (entry.output) {
      if (entry.output.stdout) formatted += `Output:\n${entry.output.stdout}\n`;
      if (entry.output.stderr) formatted += `Error Output:\n${entry.output.stderr}\n`;
      if (entry.output.generatedFiles && entry.output.generatedFiles.length > 0) {
        formatted += `Generated Files: ${entry.output.generatedFiles.join(', ')}\n`;
      }
    }
    if (entry.error) formatted += `Error: ${entry.error}\n`;
    formatted += `---\n`;
    return formatted;
  }).join('\n');
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const sessionId = `interactive-${uuidv4()}`;
  const commandHistory: CommandHistory[] = [];
  
  // Create the execution tool with shared workspace
  const { codeExecutionTool, executionEngine } = createCodeExecutionTool({
    defaultStrategy: 'per_session',
    sessionId,
    verbosity: 'info',
    workspaceSharing: 'shared'
  });

  // Create initial session
  await executionEngine.createSession({
    sessionId,
    strategy: ContainerStrategy.PER_SESSION,
    containerConfig: {
      image: getImageForLanguage('shell')
    }
  });

  // Get session info for workspace directory
  const sessionInfo = await executionEngine.getSessionInfo(sessionId);
  const workspaceDir = sessionInfo.currentContainer.meta?.workspaceDir;

  // Create file tools for the workspace directory
  const { createFileStructureTool, writeFileTool, readFileTool, listFilesTool } = createFileTools(workspaceDir ?? process.cwd());

  console.log('⚡️ AI Shell ⚡️ - code-interpreter-tools interactive shell example');
  console.log('GitHub: https://github.com/CatchTheTornado/code-interpreter-tools\n');
  console.log('Workspace Directory:', workspaceDir);
  console.log('Type your commands or AI prompts below.');
  console.log('Special commands:');
  console.log('  - "info" - Show session information and container history');
  console.log('  - "history" - Show command history');
  console.log('  - "quit" - Exit the shell');
  console.log('\n');

  const prompt = () => {
    rl.question('> ', async (input) => {
      if (input.toLowerCase() === 'quit') {
        rl.close();
        return;
      }

      if (input.toLowerCase() === 'info') {
        const sessionInfo = await executionEngine.getSessionInfo(sessionId);
        console.log('\n=== Session Information ===');
        console.log('Session ID:', sessionInfo.sessionId);
        console.log('Created:', sessionInfo.createdAt);
        console.log('Last Executed:', sessionInfo.lastExecutedAt || 'Never');
        console.log('Active:', sessionInfo.isActive ? 'Yes' : 'No');
        console.log('\nCurrent Container:');
        console.log('- Image:', sessionInfo.currentContainer.container ? 
          (await sessionInfo.currentContainer.container.inspect()).Config.Image : 'None');
        console.log('- Running:', sessionInfo.currentContainer.meta?.isRunning ? 'Yes' : 'No');
        console.log('- Created:', sessionInfo.currentContainer.meta?.createdAt);
        console.log('- Last Executed:', sessionInfo.currentContainer.meta?.lastExecutedAt || 'Never');
        
        console.log('\nContainer History:');
        sessionInfo.containerHistory.forEach((meta, index) => {
          console.log(`\nContainer ${index + 1}:`);
          console.log('- Name:', meta.containerName);
          console.log('- Image:', meta.imageName);
          console.log('- Container ID:', meta.containerId);
          console.log('- Created:', meta.createdAt);
          console.log('- Last Executed:', meta.lastExecutedAt || 'Never');
          console.log('- Generated Files:', meta.sessionGeneratedFiles.size);
        });
        console.log('\n');
        prompt();
        return;
      }

      if (input.toLowerCase() === 'history') {
        console.log('\n=== Command History ===\n');
        commandHistory.forEach((entry, index) => {
          console.log(`[${index + 1}] ${entry.input}`);
          if (entry.error) {
            console.log('   Error:', entry.error);
          }
          console.log();
        });
        prompt();
        return;
      }

      startSpinner('AI Thinking...');
      
      try {
        const historyContext = formatHistoryForAI(commandHistory);
        const result = await generateText({
          model: openai('gpt-4'),
          maxSteps: 1,
          messages: [
            {
              role: 'system',
              content: `You are an AI assistant in an interactive shell environment. Shell is bash, you are on alpine linux. Use "apk" in case of missing shell commands. Here is the history of previous commands and their outputs:\n\n${historyContext}\n\nBased on this history, execute the following command or prompt. Use the "codeExecutionTool" to execute the code to achieve the user desired result. If not specified differently, try to use "shell" or "python" languages. If using non-standard modules, pass them as "dependencies" to be installed. If user asks about the history or context shared with the conversation and you can answer based on the information you already have you do not need to call any command - just answer, but do not assume anything which is dynamic - for example always check the files and folder content using "codeExecutionTool" and do not assume you know it.
                        When asked to generate a file structure or create multiple files, call the "createFileStructureTool" tool and pass the JSON object describing the structure as the "structure" argument. The JSON should be in this format:
                        {
                          "structure": {
                            "files": [
                              {
                                "path": "path/to/file",
                                "content": "file content",
                                "description": "what this file does"
                              }
                            ],
                            "dependencies": ["list", "of", "dependencies"]
                          }
                        }

                        `
            },
            {
              role: 'user',
              content: input
            }
          ],
          tools: { codeExecutionTool, createFileStructureTool },
          toolChoice: 'auto'
        });

        stopSpinner(true, 'AI Response received');

        // Display execution results
        const toolResult = (result.toolResults?.[0] as any)?.result;
        const executionInfo = (result.toolCalls?.[0] as any)?.args;

        // Remove debug logs; display handled below

        // Store in history
        const historyEntry: CommandHistory = {
          input,
          executionInfo,
          output: toolResult,
          timestamp: new Date()
        };
        commandHistory.push(historyEntry);

        // Display AI textual response if provided
        if (result.text && result.text.trim().length > 0) {
          console.log('\n🤖 AI Response:');
          console.log(result.text.trim());
        }

        // Handle createFileStructureTool custom display
        if (toolResult && (toolResult.files || toolResult.dirs)) {
          const filesArr: Array<{ path: string; description?: string }> = toolResult.files ?? [];
          const dirsArr: string[] = toolResult.dirs ?? [];

          // Build dir groups
          const dirGroups: Record<string, Array<{ path: string; description?: string }>> = {};
          for (const file of filesArr) {
            const d = path.dirname(file.path);
            if (!dirGroups[d]) dirGroups[d] = [];
            dirGroups[d].push(file);
          }
          // Ensure empty dirs are included
          for (const d of dirsArr) {
            if (!dirGroups[d]) dirGroups[d] = [];
          }

          console.log('\n📂 Workspace changes:\n');
          const sortedDirs = Object.keys(dirGroups).sort();
          for (const dir of sortedDirs) {
            const prettyDir = dir === '.' ? '' : `📁 ${dir}/`;
            if (prettyDir) console.log(prettyDir);
            const filesInDir = dirGroups[dir];
            for (const f of filesInDir) {
              const fileName = path.basename(f.path);
              console.log(`${dir === '.' ? '' : '   '}📄 ${fileName}`);
              if (f.description) console.log(`${dir === '.' ? '' : '      '}${f.description}`);
            }
            if (filesInDir.length === 0) console.log(`${dir === '.' ? '' : '   '}(empty)`);
            console.log();
          }

          if (toolResult.dependencies && toolResult.dependencies.length > 0) {
            console.log('📦 Dependencies:');
            console.log('   ' + toolResult.dependencies.join(', '));
            console.log();
          }

          console.log('✨ File structure updated successfully!');
        } else if (toolResult) {
          // Show what's being executed
          if (executionInfo && executionInfo.language) {
            console.log('\nExecuting in Docker sandbox:');
            if (executionInfo.runApp) {
              console.log(`Application: ${executionInfo.runApp.entryFile}`);
              console.log(`Working directory: ${executionInfo.runApp.cwd}`);
            } else {
              console.log(`Language: ${executionInfo.language}`);
              if (executionInfo.dependencies?.length > 0) {
                console.log(`Dependencies: ${executionInfo.dependencies.join(', ')}`);
              }
              console.log('\nCode:');
              console.log('```' + executionInfo.language);
              console.log(executionInfo.code);
              console.log('```\n');
            }
          }

          console.log('\nOutput:');
          if (toolResult.stdout) {
            console.log(toolResult.stdout);
          }
          
          if (toolResult.stderr) {
            console.error(toolResult.stderr);
          }

          if (toolResult.generatedFiles?.length > 0) {
            console.log('\n[Generated files: ' + toolResult.generatedFiles.join(', ') + ']');
          }
        }

        console.log(); // Add blank line for readability
        prompt(); // Continue the loop
      } catch (error) {
        stopSpinner(false, 'Error occurred');
        console.error('Error:', error);

        // Store error in history
        commandHistory.push({
          input,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date()
        });

        // Ask AI to fix the error
        try {
          console.log('\nAttempting to fix the error...');
          const fixResult = await generateText({
            model: openai('gpt-4'),
            maxSteps: 1,
            messages: [
              {
                role: 'system',
                content: `Previous command failed with error: ${error}\n\nPlease analyze the error and provide a fixed version of the command.`
              },
              {
                role: 'user',
                content: input
              }
            ],
            tools: { codeExecutionTool, createFileStructureTool },
            toolChoice: 'auto'
          });

          // Display AI's explanation if present
          if (fixResult.text) {
            console.log('\nAI Analysis:');
            console.log(fixResult.text);
            console.log();
          }

          const fixToolResult = (fixResult.toolResults?.[0] as any)?.result;
          if (fixToolResult?.stdout || fixToolResult?.stderr) {
            console.log('\nFixed command output:');
            if (fixToolResult.stdout) console.log(fixToolResult.stdout);
            if (fixToolResult.stderr) console.error(fixToolResult.stderr);
          }
        } catch (fixError) {
          console.error('Failed to fix the error:', fixError);
        }

        console.log(); // Add blank line for readability
        prompt(); // Continue the loop
      }
    });
  };

  // Start the interactive loop
  prompt();

  // Handle cleanup on exit
  rl.on('close', async () => {
    console.log('\n🧹 Cleaning up...');
    await executionEngine.cleanupSession(sessionId);
    process.exit(0);
  });
}

main().catch(console.error);