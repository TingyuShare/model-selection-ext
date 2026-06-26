# AI Model Selector - VS Code Extension

A customizable AI model selector that supports OpenAI-compatible APIs, allowing you to use custom models in VS Code Chat.

## Features

- OpenAI-compatible API support (DeepSeek, Qwen, MiMo, local models, etc.)
- Models automatically appear in VS Code Chat model picker
- Config file is watched for changes — just save and it takes effect

## Usage

| Command | Description |
|---------|-------------|
| `ai-model: Config` | Open `.vscode/model.json` config file |

## Configuration

Run the `ai-model: Config` command to open the config file, edit and save. The config file is located at `.vscode/model.json`.

### Config Format

```json
{
  "selectedModel": "deepseek-chat",
  "models": [
    {
      "id": "deepseek-chat",
      "name": "DeepSeek Chat",
      "vendor": "deepseek",
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
| `id` | Model ID used for API calls |
| `name` | Display name in VS Code Chat |
| `vendor` | Vendor identifier |
| `apiKey` | API key for authentication |
| `baseUrl` | API base URL (e.g. `https://api.deepseek.com/v1`) |
| `maxInputTokens` | Maximum input token count |
| `maxOutputTokens` | Maximum output token count |

## Development

```bash
npm install
npm run compile
# Press F5 to launch debug
```

## Package

```bash
npm install -g @vscode/vsce
vsce package
```

## Commands

| Command | Description |
|---------|-------------|
| `modelSelector.config` | Open model configuration file |

## License

MIT License