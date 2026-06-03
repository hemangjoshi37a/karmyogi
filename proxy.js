const http = require('http');
const crypto = require('crypto');

const PORT = 3000;

const server = http.createServer(async (req, res) => {
  // Handle CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Cookie');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Helper to read request body
  const readBody = (request) => new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', err => reject(err));
  });

  const cookie = req.headers['x-session-cookie'];
  if (!cookie) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Missing X-Session-Cookie header' } }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody);
      const messages = body.messages || [];
      const systemMessage = messages.find(m => m.role === 'system')?.content || '';
      const userMessages = messages.filter(m => m.role === 'user');
      const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';
      const prompt = systemMessage ? `${systemMessage}\n\nUser request: ${lastUserMessage}` : lastUserMessage;

      // 1. Get Access Token
      console.log('Authenticating ChatGPT session...');
      const sessionRes = await fetch('https://chatgpt.com/api/auth/session', {
        headers: {
          'Cookie': cookie,
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (!sessionRes.ok) {
        res.writeHead(sessionRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Failed to authenticate session: HTTP ${sessionRes.status}` } }));
        return;
      }

      const sessionData = await sessionRes.json();
      const accessToken = sessionData.accessToken;
      if (!accessToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No access token returned in session. Is your cookie expired?' } }));
        return;
      }

      // 2. Call ChatGPT Web API
      console.log('Sending prompt to ChatGPT Web API...');
      const model = body.model === 'gpt-4o-mini' ? 'gpt-4o-mini' : 'auto';
      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();

      const chatRes = await fetch('https://chatgpt.com/backend-api/conversation', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          action: 'next',
          messages: [
            {
              id: uuid1,
              author: { role: 'user' },
              content: { content_type: 'text', parts: [prompt] },
              metadata: {}
            }
          ],
          parent_message_id: uuid2,
          model: model,
          timezone_offset_min: -330,
          suggestions: [],
          history_and_training_disabled: true,
          conversation_mode: 'kindle'
        })
      });

      if (!chatRes.ok) {
        const errText = await chatRes.text();
        res.writeHead(chatRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `ChatGPT API error: HTTP ${chatRes.status}. ${errText}` } }));
        return;
      }

      // Read SSE stream
      let responseText = '';
      const reader = chatRes.body;
      if (!reader) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Response body is empty' } }));
        return;
      }

      // We read the stream chunks
      for await (const chunk of reader) {
        const lines = Buffer.from(chunk).toString('utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') break;
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

      if (!responseText) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'ChatGPT returned empty response.' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: responseText
            }
          }
        ]
      }));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/messages') {
    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody);
      const messages = body.messages || [];
      const systemMessage = body.system || '';
      const userMessages = messages.filter(m => m.role === 'user');
      const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';
      const prompt = systemMessage ? `${systemMessage}\n\nUser request: ${lastUserMessage}` : lastUserMessage;

      // 1. Get Claude Org
      console.log('Fetching Claude organizations...');
      const orgRes = await fetch('https://claude.ai/api/organizations', {
        headers: {
          'Cookie': cookie,
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (!orgRes.ok) {
        res.writeHead(orgRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Failed to fetch Claude organizations: HTTP ${orgRes.status}` } }));
        return;
      }

      const orgs = await orgRes.json();
      if (!Array.isArray(orgs) || orgs.length === 0) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No organizations found for this Claude session.' } }));
        return;
      }
      const orgId = orgs[0].uuid;

      // 2. Create Conversation
      console.log('Creating Claude conversation...');
      const convUuid = crypto.randomUUID();
      const convRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
        method: 'POST',
        headers: {
          'Cookie': cookie,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({
          uuid: convUuid,
          name: ''
        })
      });

      if (!convRes.ok) {
        res.writeHead(convRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Failed to create Claude conversation: HTTP ${convRes.status}` } }));
        return;
      }

      const convData = await convRes.json();
      const conversationId = convData.uuid;

      // 3. Send Message
      console.log('Sending prompt to Claude Web API...');
      const model = body.model || 'claude-3-5-sonnet-latest';
      const chatRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`, {
        method: 'POST',
        headers: {
          'Cookie': cookie,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          prompt: prompt,
          timezone: 'UTC',
          model: model,
          rendering_mode: 'raw'
        })
      });

      if (!chatRes.ok) {
        const errText = await chatRes.text();
        res.writeHead(chatRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Claude Web API error: HTTP ${chatRes.status}. ${errText}` } }));
        return;
      }

      let responseText = '';
      const reader = chatRes.body;
      if (!reader) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Response body is empty' } }));
        return;
      }

      for await (const chunk of reader) {
        const lines = Buffer.from(chunk).toString('utf8').split('\n');
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

      if (!responseText) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Claude returned empty response.' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: [
          {
            type: 'text',
            text: responseText
          }
        ]
      }));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not Found' } }));
});

server.listen(PORT, () => {
  console.log(`Local karmyogi AI session proxy running on http://localhost:${PORT}`);
});
