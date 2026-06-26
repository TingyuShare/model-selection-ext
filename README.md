# AI Model Selector - VS Code 扩展

可自定义的 AI 模型选择器，支持 OpenAI 兼容接口，可在 VS Code Chat 中使用自定义模型。

## 功能特性

- 支持 OpenAI 兼容接口（DeepSeek、通义千问、本地模型等）
- 模型自动出现在 VS Code Chat 模型选择器中
- 配置文件自动监听变化，保存即生效

## 使用方法

| 命令 | 说明 |
|------|------|
| `ai-model: Config` | 打开 `.vscode/model.json` 配置文件 |

## 配置方法

运行 `ai-model: Config` 命令打开配置文件，编辑后保存即可。配置文件位于 `.vscode/model.json`。

### 配置文件格式

```json
{
  "selectedModel": "deepseek-chat",
  "models": [
    {
      "id": "deepseek-chat",
      "name": "DeepSeek Chat",
      "vendor": "deepseek",
      "apiKey": "sk-your-api-key",
      "apiType": "chat-completions",
      "url": "https://api.deepseek.com/v1/chat/completions",
      "toolCalling": true,
      "vision": false,
      "maxInputTokens": 128000,
      "maxOutputTokens": 16000
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `id` | 模型 ID，用于 API 调用 |
| `name` | 显示名称 |
| `vendor` | 供应商标识 |
| `apiKey` | API 密钥 |
| `apiType` | API 类型，使用 `chat-completions` |
| `url` | API 端点 URL |
| `toolCalling` | 是否支持工具调用 |
| `vision` | 是否支持图像输入 |
| `maxInputTokens` | 最大输入 token 数 |
| `maxOutputTokens` | 最大输出 token 数 |

## 开发

```bash
npm install
npm run compile
# 按 F5 启动调试
```

```bash
npm install -g @vscode/vsce
vsce package
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `modelSelector.selectModel` | 选择 AI 模型 |
| `modelSelector.addModel` | 添加自定义模型 |
| `modelSelector.removeModel` | 删除模型 |
| `modelSelector.refreshModels` | 刷新模型列表 |

## 许可证

MIT License