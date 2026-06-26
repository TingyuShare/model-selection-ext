import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { ModelEntry, ModelSelectorProvider } from './modelSelector';

interface OpenAIResponse {
    choices: Array<{
        message: { content: string };
    }>;
}

interface AnthropicResponse {
    content: Array<{
        type: string;
        text: string;
    }>;
}

interface GoogleResponse {
    candidates: Array<{
        content: {
            parts: Array<{ text: string }>;
        };
    }>;
}

export class ModelSelectorLanguageModelProvider implements vscode.LanguageModelChatProvider {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
    private selectorProvider: ModelSelectorProvider;

    constructor(selectorProvider: ModelSelectorProvider) {
        this.selectorProvider = selectorProvider;
    }

    fireChange(): void {
        this._onDidChange.fire();
    }

    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const models = this.selectorProvider.getModels();
        const selectedId = this.selectorProvider.getSelectedModelId();

        // Sort: selected model first
        const sorted = [...models].sort((a, b) => {
            if (a.id === selectedId) return -1;
            if (b.id === selectedId) return 1;
            return 0;
        });

        return sorted.map(m => ({
            id: m.id,
            name: m.name,
            family: m.id,
            version: '1.0.0',
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            capabilities: {
                imageInput: true,
                toolCalling: true,
            },
        }));
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        _options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const m = this.selectorProvider.findModelById(model.id);
        if (!m) {
            throw new Error(`Model "${model.id}" not found in configuration`);
        }

        if (!m.apiKey) {
            throw new Error(
                `No API key configured for "${m.name}". ` +
                `Run "ai-model: Config" to set it.`
            );
        }

        const chatMessages = this.extractPrompt(messages);
        if (chatMessages.length === 0) {
            chatMessages.push({ role: 'user', content: 'Hello' });
        }

        await this.callChatCompletions(m, chatMessages, progress, token);
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        }
        let totalLength = 0;
        for (const part of text.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                totalLength += part.value.length;
            }
        }
        return Math.ceil(totalLength / 4);
    }

    private extractPrompt(messages: readonly vscode.LanguageModelChatRequestMessage[]): {
        role: string;
        content: string;
    }[] {
        const chatMessages: { role: string; content: string }[] = [];
        for (const msg of messages) {
            let content = '';
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    content += part.value;
                }
            }
            if (msg.role === vscode.LanguageModelChatMessageRole.User) {
                chatMessages.push({ role: 'user', content });
            } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
                chatMessages.push({ role: 'assistant', content });
            }
        }
        return chatMessages;
    }

    private async callChatCompletions(
        m: ModelEntry,
        messages: { role: string; content: string }[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const body = JSON.stringify({
            model: m.id,
            messages,
            stream: false,
        });

        const url = new URL(m.url || 'https://api.openai.com/v1/chat/completions');
        const response = await this.httpRequest({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${m.apiKey}`,
            },
        }, body, token);

        const data = JSON.parse(response) as OpenAIResponse;
        if (data.choices && data.choices.length > 0) {
            progress.report(new vscode.LanguageModelTextPart(data.choices[0].message.content));
        }
    }

    /**
     * Anthropic messages API
     */
    private async callMessages(
        m: ModelEntry,
        messages: { role: string; content: string }[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Ensure alternating user/assistant starting with user
        const chatMessages: { role: string; content: string }[] = [];
        for (const msg of messages) {
            if (chatMessages.length === 0 && msg.role !== 'user') {
                chatMessages.push({ role: 'user', content: 'Hello' });
            }
            chatMessages.push(msg);
        }
        if (chatMessages.length === 0 || chatMessages[0].role !== 'user') {
            chatMessages.unshift({ role: 'user', content: 'Hello' });
        }
        if (chatMessages[chatMessages.length - 1].role !== 'user') {
            chatMessages.push({ role: 'user', content: 'Please continue' });
        }

        const body = JSON.stringify({
            model: m.id,
            max_tokens: m.maxOutputTokens,
            messages: chatMessages,
        });

        const url = new URL(m.url || 'https://api.anthropic.com/v1/messages');
        const response = await this.httpRequest({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': m.apiKey,
                'anthropic-version': '2023-06-01',
            },
        }, body, token);

        const data = JSON.parse(response) as AnthropicResponse;
        if (data.content && data.content.length > 0) {
            const text = data.content.filter(c => c.type === 'text').map(c => c.text).join('');
            progress.report(new vscode.LanguageModelTextPart(text));
        }
    }

    /**
     * Google generateContent API
     */
    private async callGenerateContent(
        m: ModelEntry,
        messages: { role: string; content: string }[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const contents = messages.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }],
        }));

        const body = JSON.stringify({
            contents,
            generationConfig: {
                maxOutputTokens: m.maxOutputTokens,
            },
        });

        const url = new URL(m.url ||
            `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent?key=${m.apiKey}`
        );
        const response = await this.httpRequest({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        }, body, token);

        const data = JSON.parse(response) as GoogleResponse;
        if (data.candidates && data.candidates.length > 0) {
            const text = data.candidates[0].content.parts.map(p => p.text).join('');
            progress.report(new vscode.LanguageModelTextPart(text));
        }
    }

    private httpRequest(
        options: https.RequestOptions,
        body: string,
        token: vscode.CancellationToken
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const transport = options.port === 80 || options.port === '80' ? http : https;
            const req = transport.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`API request failed (${res.statusCode}): ${data}`));
                    }
                });
            });

            req.on('error', reject);

            token.onCancellationRequested(() => {
                req.destroy();
                reject(new Error('Request cancelled'));
            });

            req.write(body);
            req.end();
        });
    }
}
