import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const app = express();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Private server-side Supabase client for verified payments
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.static('sites/myapp'));

app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/sites/myapp/index.html');
});

// Verify login and prepare authenticated Supabase client
async function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || '';
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token) {
      return res.status(401).json({
        error: 'Please log in to use 233 AI'
      });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      console.log('SUPABASE AUTH DEBUG:', error?.message || 'No user returned');
      return res.status(401).json({
        error: 'Invalid or expired login session'
      });
    }

    req.user = data.user;

    req.userSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_PUBLISHABLE_KEY,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    next();

  } catch (error) {
    console.error('Authentication error:', error.message);
    return res.status(401).json({
      error: 'Authentication failed'
    });
  }
}

// Owner-only dashboard statistics
app.get('/api/owner/dashboard', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase.rpc('owner_dashboard_stats');

    if (error) {
      console.error('Owner dashboard error:', error.message);
      if (error.code === '42501') {
        return res.status(403).json({ error: 'Owner access required' });
      }
      return res.status(503).json({ error: 'Unable to load owner dashboard' });
    }

    return res.json(data);
  } catch (error) {
    console.error('Owner dashboard error:', error.message);
    return res.status(500).json({ error: 'Unable to load owner dashboard' });
  }
});

// Owner-only user management
app.get('/api/owner/users', requireAuth, async (req, res) => {
  try {
    const search = typeof req.query.search === 'string'
      ? req.query.search.trim().slice(0, 100)
      : null;

    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

    const { data, error } = await req.userSupabase.rpc('owner_list_users', {
      p_search: search || null,
      p_limit: limit,
      p_offset: offset
    });

    if (error) {
      console.error('Owner user-list error:', error.message);
      if (error.code === '42501') {
        return res.status(403).json({ error: 'Owner access required' });
      }
      return res.status(503).json({ error: 'Unable to load users' });
    }

    return res.json(data);
  } catch (error) {
    console.error('Owner user-list error:', error.message);
    return res.status(500).json({ error: 'Unable to load users' });
  }
});

// Protected AI chat with daily plan limits
app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, history } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      error: 'Message is required'
    });
  }

  try {
    // Atomically consume one daily message
    const { data, error } = await req.userSupabase.rpc(
      'consume_chat_message'
    );

    if (error) {
      console.error('Usage check error:', error.message);
      return res.status(503).json({
        error: 'Unable to check your message limit. Please try again.'
      });
    }

    const usage = Array.isArray(data) ? data[0] : data;

    if (!usage) {
      return res.status(503).json({
        error: 'Usage information unavailable'
      });
    }

    if (!usage.allowed) {
      return res.status(429).json({
        error: `Daily limit reached. Your ${usage.plan_id} plan allows ${usage.daily_limit} messages per day.`,
        plan: usage.plan_id,
        dailyLimit: usage.daily_limit,
        used: usage.message_count,
        remaining: usage.remaining
      });
    }

    res.setHeader('X-233AI-Plan', usage.plan_id);
    res.setHeader('X-233AI-Daily-Limit', String(usage.daily_limit));
    res.setHeader('X-233AI-Remaining', String(usage.remaining));

// Prepare conversation and attachment for Gemini
    let contents = Array.isArray(history) && history.length
      ? history.map(item => ({
          role: item.role,
          parts: Array.isArray(item.parts) ? [...item.parts] : []
        }))
      : [{ role: 'user', parts: [{ text: message }] }];

    const attachment = req.body.attachment;

    if (attachment) {
      if (typeof attachment.name !== 'string' ||
          typeof attachment.mimeType !== 'string') {
        return res.status(400).json({ error: 'Invalid attachment.' });
      }

      const supportedBinary = [
        'image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'application/pdf'
      ];

      if (attachment.kind === 'binary') {
        if (!supportedBinary.includes(attachment.mimeType) ||
            typeof attachment.data !== 'string' ||
            attachment.data.length > 14000000) {
          return res.status(400).json({ error: 'Unsupported or oversized attachment.' });
        }

        const lastUser = [...contents].reverse().find(item => item.role === 'user');
        if (!lastUser) {
          return res.status(400).json({ error: 'No user message found for attachment.' });
        }

        lastUser.parts.push({
          inlineData: {
            mimeType: attachment.mimeType,
            data: attachment.data
          }
        });

      } else if (attachment.kind === 'text') {
        if (typeof attachment.text !== 'string' ||
            attachment.text.length > 1000000) {
          return res.status(400).json({ error: 'Text attachment is too large.' });
        }

        const lastUser = [...contents].reverse().find(item => item.role === 'user');
        if (!lastUser) {
          return res.status(400).json({ error: 'No user message found for attachment.' });
        }

        lastUser.parts.push({
          text: 'Attached file: ' + attachment.name + '\n\n' + attachment.text
        });

      } else {
        return res.status(400).json({ error: 'Unsupported attachment format.' });
      }
    }

    // Generate Gemini response
    const stream = await ai.models.generateContentStream({
      model: 'gemini-3.5-flash-lite',
      contents
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');

    for await (const chunk of stream) {
      if (chunk.text) {
        res.write(chunk.text);
      }
    }

    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);

    if (!res.headersSent) {
      res.status(500).json({
        error: 'AI response failed'
      });
    } else {
      res.end();
    }
  }
});



// Generate a structured website or web app project
app.post('/api/build', requireAuth, async (req, res) => {
  const prompt = req.body?.prompt;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Describe the project you want to build.' });
  }

  if (prompt.length > 5000) {
    return res.status(400).json({ error: 'Project description is too long. Maximum is 5,000 characters.' });
  }

  try {
    // Build requests use the same daily allowance as chat
    const { data, error } = await req.userSupabase.rpc('consume_chat_message');

    if (error) {
      console.error('Build usage check error:', error.message);
      return res.status(503).json({ error: 'Unable to check your daily limit.' });
    }

    const usage = Array.isArray(data) ? data[0] : data;

    if (!usage) {
      return res.status(503).json({ error: 'Usage information unavailable.' });
    }

    if (!usage.allowed) {
      return res.status(429).json({
        error: `Daily limit reached. Your ${usage.plan_id} plan allows ${usage.daily_limit} requests per day.`,
        plan: usage.plan_id,
        dailyLimit: usage.daily_limit,
        used: usage.message_count,
        remaining: usage.remaining
      });
    }

    res.setHeader('X-233AI-Plan', usage.plan_id);
    res.setHeader('X-233AI-Daily-Limit', String(usage.daily_limit));
    res.setHeader('X-233AI-Remaining', String(usage.remaining));

    const buildInstructions = `
You are the project-building engine for 233 AI.
Create a complete, working website or browser-based web application from this request:

${prompt.trim()}

Return ONLY valid JSON with this exact structure:
{
  "name": "Short project name",
  "description": "Brief project description",
  "files": [
    { "path": "index.html", "content": "complete HTML source" },
    { "path": "style.css", "content": "complete CSS source" },
    { "path": "script.js", "content": "complete JavaScript source" }
  ]
}

Rules:
- Generate separate index.html, style.css and script.js files.
- Include all three files, even if one has minimal content.
- Link style.css and script.js correctly from index.html.
- Make the project functional, responsive and mobile-friendly.
- Use accessible labels and sensible error handling.
- Do not use server-side code, secrets, API keys or real payment processing.
- Do not claim that login, payments or cloud storage work unless implemented with a real secure backend.
- Do not include external scripts or remote dependencies.
- Keep all code inside the three requested files.
- Do not use Markdown fences or explanations outside the JSON.
`;

    const result = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: buildInstructions }] }]
    });

    let output = result.text;

    if (typeof output !== 'string' || !output.trim()) {
      throw new Error('The AI returned an empty project.');
    }

    output = output.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

    const project = JSON.parse(output);
    const allowedFiles = new Set(['index.html', 'style.css', 'script.js']);

    if (!project || !Array.isArray(project.files)) {
      throw new Error('Invalid project structure returned by AI.');
    }

    const files = [];
    let totalSize = 0;

    for (const file of project.files) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        !allowedFiles.has(file.path) ||
        typeof file.content !== 'string'
      ) {
        throw new Error('The AI returned an unsupported project file.');
      }

      totalSize += Buffer.byteLength(file.content, 'utf8');

      if (totalSize > 50000) {
        throw new Error('Generated project is too large. Please try a simpler request.');
      }

      if (files.some(item => item.path === file.path)) {
        throw new Error('Duplicate project file returned.');
      }

      files.push({ path: file.path, content: file.content });
    }

    if (!files.some(file => file.path === 'index.html')) {
      throw new Error('The project is missing its main HTML file.');
    }

    return res.json({
      success: true,
      project: {
        name: typeof project.name === 'string' ? project.name.slice(0, 80) : 'My 233 AI Project',
        description: typeof project.description === 'string' ? project.description.slice(0, 300) : '',
        files
      },
      usage: {
        plan: usage.plan_id,
        remaining: usage.remaining
      }
    });

  } catch (error) {
    console.error('Build error:', error.message);
    return res.status(500).json({ error: 'Project generation failed. Please try again.' });
  }
});

// Start Premium payment through Paystack
app.post('/api/payments/initialize', requireAuth, async (req, res) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ error: 'Payment service is not configured' });
    }

    if (!req.user.email) {
      return res.status(400).json({ error: 'Account email is required' });
    }

    const { data: existing } = await supabaseAdmin
      .from('subscriptions')
      .select('plan_id, status')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existing?.plan_id === 'owner') {
      return res.status(403).json({ error: 'Owner accounts do not need Premium' });
    }

    const { data: plan, error: planError } = await supabaseAdmin
      .from('plans')
      .select('price_monthly')
      .eq('id', 'premium')
      .single();

    if (planError || Number(plan.price_monthly) !== 200) {
      return res.status(503).json({ error: 'Premium pricing is not configured correctly' });
    }

    const reference = randomUUID();
    const amount = 20000;

    const { error: insertError } = await supabaseAdmin
      .from('payment_transactions')
      .insert({
        user_id: req.user.id,
        plan_id: 'premium',
        reference,
        amount,
        currency: 'GHS',
        status: 'pending'
      });

    if (insertError) throw insertError;

    const paystackResponse = await fetch(
      'https://api.paystack.co/transaction/initialize',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: req.user.email,
          amount,
          currency: 'GHS',
          reference
        })
      }
    );

    const result = await paystackResponse.json();

    if (!paystackResponse.ok || !result.status || !result.data?.authorization_url) {
      console.error('Paystack initialization failed:', result.message);
      return res.status(502).json({ error: 'Unable to start payment. Please try again.' });
    }

    return res.json({
      authorization_url: result.data.authorization_url,
      reference
    });

  } catch (error) {
    console.error('Payment initialization error:', error.message);
    return res.status(500).json({ error: 'Unable to initialize payment' });
  }
});

// Verify payment before granting Premium
app.post('/api/payments/verify', requireAuth, async (req, res) => {
  try {
    const reference = typeof req.body.reference === 'string'
      ? req.body.reference.trim()
      : '';

    if (!reference || reference.length > 100) {
      return res.status(400).json({ error: 'A valid payment reference is required' });
    }

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payment_transactions')
      .select('*')
      .eq('reference', reference)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (paymentError || !payment) {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    if (payment.status === 'success') {
      return res.json({ success: true, premium: true, message: 'Premium is active' });
    }

    if (payment.status !== 'pending') {
      return res.status(400).json({ error: 'This payment cannot be verified' });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const result = await response.json();
    const transaction = result.data;

    if (
      !response.ok ||
      !result.status ||
      transaction?.status !== 'success' ||
      transaction.reference !== reference ||
      transaction.amount !== payment.amount ||
      transaction.currency !== payment.currency ||
      payment.amount !== 20000 ||
      payment.currency !== 'GHS'
    ) {
      return res.status(400).json({ error: 'Payment has not been successfully verified' });
    }

    const { data: activated, error: activationError } = await supabaseAdmin.rpc(
      'complete_premium_payment',
      {
        p_reference: reference,
        p_amount: transaction.amount,
        p_currency: transaction.currency
      }
    );

    if (activationError) {
      console.error('Premium activation error:', activationError.message);
      return res.status(503).json({ error: 'Payment verified, but activation needs attention' });
    }

    return res.json({
      success: true,
      premium: true,
      message: 'Premium activated successfully'
    });

  } catch (error) {
    console.error('Payment verification error:', error.message);
    return res.status(500).json({ error: 'Unable to verify payment' });
  }
});

// Retrieve the signed-in user's subscription
app.get('/api/account/subscription', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('plan_id, status, expires_at')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) throw error;

    const expired = data?.expires_at &&
      new Date(data.expires_at).getTime() <= Date.now();

    const active = data?.status === 'active' && !expired;

    return res.json({
      plan_id: active ? data.plan_id : 'free',
      status: active ? 'active' : 'inactive',
      expires_at: data?.expires_at || null
    });

  } catch (error) {
    console.error('Subscription lookup error:', error.message);
    return res.status(503).json({ error: 'Unable to load subscription' });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`233 AI server running on port ${PORT}`);
});
