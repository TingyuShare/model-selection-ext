import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { ModelEntry, ModelSelectorProvider, getModelName, getModelVendor, getModelKey } from './modelSelector';

interface OpenAIResponse {
    choices: Array<{
        message?: {
            content: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
            }> | null;
        };
        delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
            }> | null;
        };
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

    dispose(): void {
        this._onDidChange.dispose();
    }

    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const models = this.selectorProvider.getModels();
        const selectedKey = this.selectorProvider.getSelectedModelId();

        // Sort: selected model first
        const sorted = [...models].sort((a, b) => {
            if (getModelKey(a) === selectedKey) return -1;
            if (getModelKey(b) === selectedKey) return 1;
            return 0;
        });

        return sorted.map(m => ({
            id: getModelKey(m),
            name: getModelName(m),
            family: m.id,
            version: '1.0.0',
            tooltip: `${getModelName(m)} · ${m.baseUrl || 'default endpoint'}`,
            detail: 'AI Model Selector',
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            capabilities: {
                imageInput: m.imageInput ?? true,
                toolCalling: m.toolCalling ?? true,
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
        const m = this.selectorProvider.findModelByKey(model.id);
        if (!m) {
            throw new Error(`Model "${model.id}" not found in configuration`);
        }

        if (!m.apiKey) {
            throw new Error(
                `No API key configured for "${getModelName(m)}". ` +
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
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    // Tool results: serialize as JSON string
                    content += JSON.stringify(part.content);
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
            stream: true,
        });

        const endpoint = (m.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
        const url = new URL(endpoint);

        const responseStream = await this.httpStreamRequest({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${m.apiKey}`,
            },
        }, body, token);

        const decoder = new TextDecoder();
        let buffer = '';

        for await (const sseChunk of responseStream) {
            buffer += decoder.decode(sseChunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop()!; // keep incomplete line in buffer

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') return;

                try {
                    const parsed = JSON.parse(data) as OpenAIResponse;
                    const chunk = parsed.choices?.[0]?.delta;
                    if (!chunk) continue;

                    if (chunk.tool_calls) {
                        for (const tc of chunk.tool_calls) {
                            let args: Record<string, unknown> = {};
                            try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
                            progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, args));
                        }
                    }

                    const text = chunk.content || chunk.reasoning_content || '';
                    if (text) {
                        progress.report(new vscode.LanguageModelTextPart(text));
                    }
                } catch { /* skip malformed SSE line */ }
            }
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

        const endpoint = (m.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '') + '/messages';
        const url = new URL(endpoint);
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

        const endpoint = (m.baseUrl ||
            `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent`
        ).replace(/\/+$/, '');
        const separator = endpoint.includes('?') ? '&' : '?';
        const url = new URL(endpoint + `${separator}key=${m.apiKey}`);
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

    private httpStreamRequest(
        options: https.RequestOptions,
        body: string,
        token: vscode.CancellationToken,
        timeoutMs: number = 120000
    ): Promise<AsyncIterable<Buffer>> {
        return new Promise((resolve, reject) => {
            const transport = options.port === 80 || options.port === '80' ? http : https;
            const req = transport.request(options, (res) => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(res as unknown as AsyncIterable<Buffer>);
                } else {
                    let errData = '';
                    res.on('data', (chunk) => { errData += chunk; });
                    res.on('end', () => {
                        reject(new Error(`API request failed (${res.statusCode}): ${errData}`));
                    });
                }
            });

            req.setTimeout(timeoutMs, () => {
                req.destroy();
                reject(new Error(`Request timed out after ${timeoutMs}ms`));
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

    private httpRequest(
        options: https.RequestOptions,
        body: string,
        token: vscode.CancellationToken,
        timeoutMs: number = 60000
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

            req.setTimeout(timeoutMs, () => {
                req.destroy();
                reject(new Error(`Request timed out after ${timeoutMs}ms`));
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