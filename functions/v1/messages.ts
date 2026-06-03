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
  const systemMessage = body.system || '';
  const userMessages = messages.filter((m: any) => m.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';

  // Combine system prompt and user prompt
  const prompt = systemMessage ? `${systemMessage}\n\nUser request: ${lastUserMessage}` : lastUserMessage;

  // 1. Get Claude organization UUID
  let orgId: string;
  try {
    const orgRes = await fetch('https://claude.ai/api/organizations', {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (!orgRes.ok) {
      return new Response(
        JSON.stringify({ error: { message: `Failed to fetch Claude organizations: HTTP ${orgRes.status}` } }),
        { status: orgRes.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const orgs: any = await orgRes.json();
    if (!Array.isArray(orgs) || orgs.length === 0) {
      return new Response(
        JSON.stringify({ error: { message: 'No organizations found for this Claude session.' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    orgId = orgs[0].uuid;
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { message: `Claude org fetch error: ${err.message}` } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Create Claude chat conversation
  let conversationId: string;
  try {
    const convUuid = crypto.randomUUID();
    const convRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        uuid: convUuid,
        name: '',
      }),
    });

    if (!convRes.ok) {
      return new Response(
        JSON.stringify({ error: { message: `Failed to create Claude conversation: HTTP ${convRes.status}` } }),
        { status: convRes.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const convData: any = await convRes.json();
    conversationId = convData.uuid;
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { message: `Claude conversation creation error: ${err.message}` } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Send prompt to Claude chat conversation
  try {
    // Map models to standard web slugs if necessary (Claude Web uses specific internal model names)
    const model = body.model || 'claude-3-5-sonnet-latest';

    const chatRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        prompt: prompt,
        timezone: 'UTC',
        model: model,
        rendering_mode: 'raw',
      }),
    });

    if (!chatRes.ok) {
      const errText = await chatRes.text();
      return new Response(
        JSON.stringify({ error: { message: `Claude Web API error: HTTP ${chatRes.status}. ${errText}` } }),
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
          try {
            const parsed = JSON.parse(dataStr);
            if (typeof parsed?.completion === 'string') {
              responseText += parsed.completion;
            }
          } catch {
            // Ignore parse errors on intermediate lines
          }
        }
      }
    }

    if (!responseText) {
      return new Response(JSON.stringify({ error: { message: 'Claude returned an empty response.' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        content: [
          {
            type: 'text',
            text: responseText,
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
