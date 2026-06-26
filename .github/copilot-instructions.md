<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

# Project Instructions for AI Model Selector Extension

This is a VS Code extension project that provides a customizable AI model selector.

## Project Structure

- `src/extension.ts` - Main extension entry point
- `src/modelSelector.ts` - Model selector provider class
- `package.json` - Extension manifest and configuration
- `tsconfig.json` - TypeScript configuration

## Development Guidelines

1. **TypeScript**: Use TypeScript for all source code
2. **VS Code API**: Follow VS Code extension best practices
3. **Configuration**: Use VS Code configuration API for settings
4. **Commands**: Register all commands in package.json contributes section

## Key Features

- Model selection via QuickPick
- Custom model management (add/remove)
- Status bar integration
- Configuration persistence

## Testing

- Test all commands manually
- Verify configuration changes persist
- Check status bar updates correctly