 # AI Model Selector - VS Code Extension

A VS Code Chat provider for custom OpenAI-compatible models. Define your endpoints and models in a simple JSON config file, then use the extension to surface them in VS Code Chat.

## Features

- Custom model provider for VS Code Chat
- Auto-loads models from `.vscode/model.json`
- Auto-refreshes when the config file is saved
- Supports OpenAI-compatible endpoints and self-hosted APIs
- Workspace config with global fallback for no-workspace scenarios

## Quick Start

1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run `ai-model: Config`
3. Edit the generated `.vscode/model.json`
4. Save the file and open VS Code Chat

## Config File

The extension stores model definitions in `.vscode/model.json` for workspace use. If no workspace is open, it falls back to a `model.json` file in the extension's global storage.

The config file is created automatically on first activation if it does not exist.

### Example config

```json
{
  "models": [
    {
      "id": "deepseek-v4-pro",
      "apiKey": "sk-your-api-key",
      "baseUrl": "https://api.deepseek.com/v1",
      "maxInputTokens": 128000,
      "maxOutputTokens": 16000
    }
  ]
}
```

### Field Reference

| Field | Description |
|-------|-------------|
| `id` | Model identifier used internally and in the picker |
| `name` | Display name shown in VS Code Chat |
| `vendor` | Optional vendor identifier, inferred from `id` if omitted |
| `apiKey` | API key for the endpoint |
| `baseUrl` | Base URL for API requests (example: `https://api.deepseek.com/v1`) |
| `maxInputTokens` | Maximum input token count |
| `maxOutputTokens` | Maximum output token count |
| `imageInput` | Optional `boolean` to indicate image input support |
| `toolCalling` | Optional `boolean` to indicate tool calling support |

### Compatibility

The extension also recognizes legacy `endpoints` config format and converts it to the current `models` format automatically.

## Commands

| Command | Description |
|---------|-------------|
| `modelSelector.config` | Open the model configuration file |

## Development

```bash
npm install
npm run compile
# then press F5 in VS Code to launch the extension host
```

## Packaging

```bash
npm install -g @vscode/vsce
vsce package
```

## License

MIT License
