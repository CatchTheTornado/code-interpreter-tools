import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createCodeExecutionTool, getImageForLanguage } from '../src/code-execution-tool';
import { v4 as uuidv4 } from 'uuid';
import { ContainerStrategy } from '../src/types';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';

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

  console.log('\n=== Interactive AI Shell ===\n');
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
              content: `You are an AI assistant in an interactive shell environment. Here is the history of previous commands and their outputs:\n\n${historyContext}\n\nBased on this history, execute the following command or prompt. If not specified differently, try to use shell or python. If using non-standard modules, pass them as "dependencies" to be installed. If user asks about the history or context shared with the conversation and you can answer based on the information you already have you do not need to call any command - just answer.

When asked to generate a file structure or create multiple files, respond with a JSON object in this format:
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

The shell will automatically create these files in the workspace.`
            },
            {
              role: 'user',
              content: input
            }
          ],
          tools: { codeExecutionTool },
          toolChoice: 'auto'
        });

        stopSpinner(true, 'AI Response received');

        // Display execution results
        const toolResult = (result.toolResults?.[0] as any)?.result;
        const executionInfo = (result.toolCalls?.[0] as any)?.args;

        // Store in history
        const historyEntry: CommandHistory = {
          input,
          executionInfo,
          output: toolResult,
          timestamp: new Date()
        };
        commandHistory.push(historyEntry);

        // Display AI response if no command was executed
        if (!executionInfo && result.text) {
          console.log('\nAI Response:');
          
          // Check if the response contains a JSON structure
          try {
            // Try to find JSON in the text (looking for content between ```json and ```)
            const jsonMatch = result.text.match(/```json\n([\s\S]*?)\n```/);
            let jsonContent = jsonMatch ? jsonMatch[1] : result.text;
            
            // Try to parse the JSON
            const response = JSON.parse(jsonContent);
            if (response.structure?.files) {
              // Extract and display the text explanation before the JSON
              const textExplanation = result.text.split('```json')[0].trim();
              if (textExplanation) {
                console.log(textExplanation);
                console.log();
              }
              
              console.log('Generating file structure...\n');
              
              // Group files by directory for better presentation
              const filesByDir = response.structure.files.reduce((acc: { [key: string]: Array<{ path: string; content: string; description: string }> }, file) => {
                const dir = path.dirname(file.path);
                if (!acc[dir]) acc[dir] = [];
                acc[dir].push(file);
                return acc;
              }, {});
              
              // Create files and display in a directory-based structure
              for (const [dir, files] of Object.entries(filesByDir)) {
                if (dir !== '.') {
                  console.log(`📁 ${dir}/`);
                }
                
                for (const file of files) {
                  const filePath = path.join(process.cwd(), file.path);
                  const dirPath = path.dirname(filePath);
                  
                  // Create directory if it doesn't exist
                  if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                  }
                  
                  // Write file
                  fs.writeFileSync(filePath, file.content);
                  
                  const fileName = path.basename(file.path);
                  console.log(`   📄 ${fileName}`);
                  console.log(`      ${file.description}`);
                }
                console.log();
              }

              // Show dependencies if any
              if (response.structure.dependencies?.length > 0) {
                console.log('Dependencies:');
                console.log('   ' + response.structure.dependencies.join(', '));
                console.log();
              }

              console.log('✨ Files have been generated successfully!');
            } else {
              console.log(result.text);
            }
          } catch (e) {
            // If not a JSON or doesn't match the structure, display as regular text
            console.log(result.text);
          }
          console.log();
        }

        if (toolResult) {
          // Show what's being executed
          if (executionInfo) {
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
            tools: { codeExecutionTool },
            toolChoice: 'auto'
          });

          // Display AI's explanation if present
          if (fixResult.text) {
            console.log('\nAI Analysis:');
            console.log(fixResult.text);
            console.log();
          }

          const fixToolResult = (fixResult.toolResults?.[0] as any)?.result;
          if (fixToolResult) {
            console.log('\nFixed command output:');
            if (fixToolResult.stdout) console.log(fixToolResult.stdout);
            if (fixToolResult.stderr) console.error(fixToolResult.stderr);
          }
        } catch (fixError) {
          console.error('Failed to fix the error:', fixError);
        }
      }

      console.log(); // Add blank line for readability
      prompt(); // Continue the loop
    });
  };

  // Start the interactive loop
  prompt();

  // Handle cleanup on exit
  rl.on('close', async () => {
    console.log('\nCleaning up...');
    await executionEngine.cleanupSession(sessionId);
    process.exit(0);
  });
}

main().catch(console.error); 