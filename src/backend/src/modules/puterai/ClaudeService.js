const { default: Anthropic } = require("@anthropic-ai/sdk");
const BaseService = require("../../services/BaseService");
const { whatis } = require("../../util/langutil");
const { PassThrough } = require("stream");
const { TypedValue } = require("../../services/drivers/meta/Runtime");
const APIError = require("../../api/APIError");

const PUTER_PROMPT = `
    You are running on an open-source platform called Puter,
    as the Claude implementation for a driver interface
    called puter-chat-completion.
    
    The following JSON contains system messages from the
    user of the driver interface (typically an app on Puter):
`.replace('\n', ' ').trim();

const MAX_CLAUDE_INPUT_TOKENS = 10000;

class ClaudeService extends BaseService {
    static MODULES = {
        Anthropic: require('@anthropic-ai/sdk'),
    }
    
    async _init () {
        this.anthropic = new Anthropic({
            apiKey: this.config.apiKey
        });

        const svc_aiChat = this.services.get('ai-chat');
        svc_aiChat.register_provider({
            service_name: this.service_name,
            alias: true,
        });
    }
    
    static IMPLEMENTS = {
        ['puter-chat-completion']: {
            async models () {
                return await this.models_();
            },
            async list () {
                const models = await this.models_();
                const model_names = [];
                for ( const model of models ) {
                    model_names.push(model.id);
                    if ( model.aliases ) {
                        model_names.push(...model.aliases);
                    }
                }
                return model_names;
            },
            async complete ({ messages, stream, model }) {
                const adapted_messages = [];
                
                const system_prompts = [];
                let previous_was_user = false;
                for ( const message of messages ) {
                    if ( typeof message.content === 'string' ) {
                        message.content = {
                            type: 'text',
                            text: message.content,
                        };
                    }
                    if ( whatis(message.content) !== 'array' ) {
                        message.content = [message.content];
                    }
                    if ( ! message.role ) message.role = 'user';
                    if ( message.role === 'user' && previous_was_user ) {
                        const last_msg = adapted_messages[adapted_messages.length-1];
                        last_msg.content.push(
                            ...(Array.isArray ? message.content : [message.content])
                        );
                        continue;
                    }
                    if ( message.role === 'system' ) {
                        system_prompts.push(...message.content);
                        continue;
                    }
                    adapted_messages.push(message);
                    if ( message.role === 'user' ) {
                        previous_was_user = true;
                    }
                }

                const token_count = (() => {
                    const text = JSON.stringify(adapted_messages) +
                        JSON.stringify(system_prompts);
                    
                    // This is the most accurate token counter available for Claude.
                    return text.length / 4;
                })();

                if ( token_count > MAX_CLAUDE_INPUT_TOKENS ) {
                    throw APIError.create('max_tokens_exceeded', null, {
                        input_tokens: token_count,
                        max_tokens: MAX_CLAUDE_INPUT_TOKENS,
                    });
                }
                
                if ( stream ) {
                    const stream = new PassThrough();
                    const retval = new TypedValue({
                        $: 'stream',
                        content_type: 'application/x-ndjson',
                        chunked: true,
                    }, stream);
                    (async () => {
                        const completion = await this.anthropic.messages.stream({
                            model: model ?? 'claude-3-5-sonnet-latest',
                            max_tokens: 1000,
                            temperature: 0,
                            system: PUTER_PROMPT + JSON.stringify(system_prompts),
                            messages: adapted_messages,
                        });
                        for await ( const event of completion ) {
                            if (
                                event.type !== 'content_block_delta' ||
                                event.delta.type !== 'text_delta'
                            ) continue;
                            const str = JSON.stringify({
                                text: event.delta.text,
                            });
                            stream.write(str + '\n');
                        }
                        stream.end();
                    })();

                    return retval;
                }

                const msg = await this.anthropic.messages.create({
                    model: 'claude-3-5-sonnet-latest',
                    max_tokens: 1000,
                    temperature: 0,
                    system: PUTER_PROMPT + JSON.stringify(system_prompts),
                    messages: adapted_messages,
                });
                return {
                    message: msg,
                    finish_reason: 'stop'
                };
            }
        }
    }

    async models_ () {
        return [
            {
                id: 'claude-3-5-sonnet-20241022',
                aliases: ['claude-3-5-sonnet-latest'],
                cost: {
                    currency: 'usd-cents',
                    tokens: 1_000_000,
                    input: 300,
                    output: 1500,
                },
                qualitative_speed: 'fast',
                max_output: 8192,
                training_cutoff: '2024-04',
            },
            {
                id: 'claude-3-5-sonnet-20240620',
                succeeded_by: 'claude-3-5-sonnet-20241022',
                cost: {
                    currency: 'usd-cents',
                    tokens: 1_000_000,
                    input: 300,
                    output: 1500,
                },
            },
            {
                id: 'claude-3-haiku-20240307',
                // aliases: ['claude-3-haiku-latest'],
                cost: {
                    currency: 'usd-cents',
                    tokens: 1_000_000,
                    input: 25,
                    output: 125,
                },
                qualitative_speed: 'fastest',
            },
        ];
    }
}

module.exports = {
    ClaudeService,
};
