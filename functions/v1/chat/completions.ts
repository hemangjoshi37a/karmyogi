export const onRequestPost: PagesFunction = async (context) => {
  const request = context.request;
  const cookie = request.headers.get('X-Session-Cookie');
  if (!cookie) {
    return new Response(JSON.stringify({ error: { message: 'Missing X-Session-Cookie header' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const messages = body.messages || [];
  const systemMessage = messages.find((m: any) => m.role === 'system')?.content || '';
  const userMessages = messages.filter((m: any) => m.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';

  // Combine system prompt and user prompt
  const prompt = systemMessage ? `${systemMessage}\n\nUser request: ${lastUserMessage}` : lastUserMessage;

  // 1. Get Access Token from ChatGPT session endpoint
  let accessToken: string;
  try {
    const sessionRes = await fetch('https://chatgpt.com/api/auth/session', {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (!sessionRes.ok) {
      return new Response(
        JSON.stringify({ error: { message: `Failed to authenticate session: HTTP ${sessionRes.status}` } }),
        { status: sessionRes.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const sessionData: any = await sessionRes.json();
    accessToken = sessionData.accessToken;
    if (!accessToken) {
      return new Response(
        JSON.stringify({ error: { message: 'No access token returned in session. Is your cookie expired?' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { message: `Session auth error: ${err.message}` } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Call ChatGPT Web API Conversation endpoint
  try {
    const model = body.model === 'gpt-4o-mini' ? 'gpt-4o-mini' : 'auto';
    const uuid1 = crypto.randomUUID();
    const uuid2 = crypto.randomUUID();

    const chatRes = await fetch('https://chatgpt.com/backend-api/conversation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        action: 'next',
        messages: [
          {
            id: uuid1,
            author: { role: 'user' },
            content: { content_type: 'text', parts: [prompt] },
            metadata: {},
          },
        ],
        parent_message_id: uuid2,
        model: model,
        timezone_offset_min: -330,
        suggestions: [],
        history_and_training_disabled: true,
        conversation_mode: 'kindle',
      }),
    });

    if (!chatRes.ok) {
      const errText = await chatRes.text();
      return new Response(
        JSON.stringify({ error: { message: `ChatGPT API error: HTTP ${chatRes.status}. ${errText}` } }),
        { status: chatRes.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Parse the event stream response
    const reader = chatRes.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let responseText = '';
    let done = false;

    if (!reader) {
      return new Response(JSON.stringify({ error: { message: 'Response body is empty' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            done = true;
            break;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const part = parsed?.message?.content?.parts?.[0];
            if (typeof part === 'string') {
              responseText = part;
            }
          } catch {
            // Ignore parse errors on intermediate lines
          }
        }
      }
    }

    if (!responseText) {
      return new Response(JSON.stringify({ error: { message: 'ChatGPT returned an empty response.' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: responseText,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Session-Cookie',
      'Access-Control-Max-Age': '86400',
    },
  });
};
