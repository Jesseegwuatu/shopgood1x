// api/index.js
// Serverless API handler for Vercel

// ========================================
// ENVIRONMENT VARIABLES (Set in Vercel)
// ========================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || 'https://shop-good.vercel.app';
const OPENROUTER_SITE_NAME = process.env.OPENROUTER_SITE_NAME || 'Shop Good';
// Use openrouter/auto to automatically select the best available model
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';

// ========================================
// CORS HEADERS
// ========================================
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
};

// ========================================
// HELPER: Send JSON Response
// ========================================
function sendJson(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...corsHeaders
    });
    res.end(JSON.stringify(data));
}

// ========================================
// HELPER: Parse JSON Body
// ========================================
async function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

// ========================================
// HELPER: Get Base URL
// ========================================
function getBaseUrl(req) {
    const host = req.headers.host || 'shop-good.vercel.app';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    return `${protocol}://${host}`;
}

// ========================================
// ========================================
// PAYMENT ROUTES
// ========================================
// ========================================

// ----------------------------------------
// POST /api/payments/initialize
// Initialize a Paystack payment
// ----------------------------------------
async function handlePaymentInitialize(req, res) {
    try {
        const body = await parseBody(req);
        const { amount, email, type, metadata } = body;

        // Validate required fields
        if (!amount || !email) {
            return sendJson(res, 400, {
                success: false,
                message: 'Amount and email are required'
            });
        }

        // Validate amount (minimum 100 NGN)
        if (amount < 100) {
            return sendJson(res, 400, {
                success: false,
                message: 'Minimum amount is ₦100'
            });
        }

        // Check Paystack secret key
        if (!PAYSTACK_SECRET_KEY) {
            console.error('PAYSTACK_SECRET_KEY is not set');
            return sendJson(res, 500, {
                success: false,
                message: 'Payment service is not configured'
            });
        }

        // Generate a unique reference
        const reference = `SG-${Date.now()}-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

        // Prepare metadata
        const metaData = {
            ...metadata,
            type: type || 'payment',
            customerEmail: email
        };

        // Call Paystack API to initialize transaction
        const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount: Math.round(amount * 100), // Paystack uses kobo
                email: email,
                reference: reference,
                callback_url: `${getBaseUrl(req)}/payment-callback.html`,
                metadata: metaData
            })
        });

        const paystackData = await paystackResponse.json();

        if (paystackData.status && paystackData.data) {
            return sendJson(res, 200, {
                success: true,
                reference: reference,
                authorization_url: paystackData.data.authorization_url,
                access_code: paystackData.data.access_code
            });
        } else {
            console.error('Paystack initialization failed:', paystackData);
            return sendJson(res, 400, {
                success: false,
                message: paystackData.message || 'Payment initialization failed'
            });
        }

    } catch (error) {
        console.error('Payment initialization error:', error);
        return sendJson(res, 500, {
            success: false,
            message: 'Internal server error'
        });
    }
}

// ----------------------------------------
// GET /api/payments/verify
// Verify a Paystack payment
// ----------------------------------------
async function handlePaymentVerify(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const reference = url.searchParams.get('reference');

        if (!reference) {
            return sendJson(res, 400, {
                success: false,
                message: 'Payment reference is required'
            });
        }

        // Check Paystack secret key
        if (!PAYSTACK_SECRET_KEY) {
            console.error('PAYSTACK_SECRET_KEY is not set');
            return sendJson(res, 500, {
                success: false,
                message: 'Payment service is not configured'
            });
        }

        // Call Paystack API to verify transaction
        const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const paystackData = await paystackResponse.json();

        if (paystackData.status && paystackData.data) {
            const data = paystackData.data;
            const status = data.status;

            const isCompleted = status === 'success';
            const isFailed = status === 'failed' || status === 'abandoned';

            const metadata = data.metadata || {};
            const customerUid = metadata.customerUid || null;

            return sendJson(res, 200, {
                success: true,
                status: isCompleted ? 'completed' : (isFailed ? 'failed' : 'pending'),
                reference: data.reference,
                amount: data.amount / 100,
                paidAt: data.paid_at,
                customerUid: customerUid,
                metadata: metadata,
                raw: data
            });
        } else {
            return sendJson(res, 400, {
                success: false,
                message: paystackData.message || 'Payment verification failed'
            });
        }

    } catch (error) {
        console.error('Payment verification error:', error);
        return sendJson(res, 500, {
            success: false,
            message: 'Internal server error'
        });
    }
}

// ----------------------------------------
// GET /api/config/paystack
// Get Paystack public key (for client-side)
// ----------------------------------------
async function handleConfigPaystack(req, res) {
    try {
        if (!PAYSTACK_PUBLIC_KEY) {
            return sendJson(res, 503, {
                success: false,
                message: 'Paystack is not configured',
                publicKey: ''
            });
        }

        return sendJson(res, 200, {
            success: true,
            publicKey: PAYSTACK_PUBLIC_KEY
        });
    } catch (error) {
        console.error('Config error:', error);
        return sendJson(res, 500, {
            success: false,
            message: 'Internal server error',
            publicKey: ''
        });
    }
}

// ========================================
// ========================================
// SUPPORT CHAT ROUTE
// ========================================
// ========================================

// ----------------------------------------
// POST /api/support/chat
// Send a message to OpenRouter AI
// ----------------------------------------
async function handleSupportChat(req, res) {
    try {
        const body = await parseBody(req);
        const { message, userName, userEmail, history } = body;

        console.log('📩 Received chat request');
        console.log('📩 Message:', message);
        console.log('📩 User:', userName, userEmail);

        if (!message || message.trim().length === 0) {
            return sendJson(res, 400, {
                success: false,
                error: 'Message is required'
            });
        }

        console.log('🔑 OPENROUTER_API_KEY exists:', typeof OPENROUTER_API_KEY !== 'undefined');
        console.log('🔑 OPENROUTER_API_KEY is set:', !!OPENROUTER_API_KEY);
        if (OPENROUTER_API_KEY) {
            console.log('🔑 OPENROUTER_API_KEY length:', OPENROUTER_API_KEY.length);
            console.log('🔑 OPENROUTER_API_KEY prefix:', OPENROUTER_API_KEY.substring(0, 10) + '...');
        }

        if (!OPENROUTER_API_KEY) {
            console.error('❌ OPENROUTER_API_KEY is not set');
            return sendJson(res, 200, {
                success: true,
                response: "The AI service is currently not configured. Please contact support@shopgood.com for assistance. 🙏",
                source: 'fallback',
                error: 'API_KEY_MISSING'
            });
        }

        const messages = [
            {
                role: 'system',
                content: `You are Vortex AI, a friendly and helpful virtual assistant for Shop Good, an e-commerce platform.

Your role is to help customers with:
- Placing orders and navigating the shop
- Understanding payment methods (Paystack, Wallet, Pay on Delivery)
- Tracking orders and understanding delivery status
- Wallet funding and management
- Vouchers and gift cards
- Returns, refunds, and cancellations
- Account management (profile, addresses, wishlist)
- General product inquiries

Important guidelines:
- Be polite, professional, and helpful
- Keep responses concise and easy to understand
- If you don't know something, be honest and suggest contacting support@shopgood.com
- Never share sensitive information or internal system details

Current context:
- User name: ${userName || 'Guest'}
- User email: ${userEmail || 'Not provided'}
- Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

Always respond in a warm, conversational tone and sign off as "Vortex AI" when appropriate.`
            }
        ];

        if (history && Array.isArray(history) && history.length > 0) {
            const recentHistory = history.slice(-20);
            for (const entry of recentHistory) {
                if (entry.role && entry.content) {
                    messages.push({
                        role: entry.role === 'assistant' ? 'assistant' : 'user',
                        content: entry.content
                    });
                }
            }
        }

        messages.push({
            role: 'user',
            content: message
        });

        console.log('📡 Calling OpenRouter API...');
        console.log('📡 Model (using openrouter/auto):', DEFAULT_MODEL);
        console.log('📡 Message count:', messages.length);

        try {
            const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': OPENROUTER_SITE_URL,
                    'X-Title': OPENROUTER_SITE_NAME
                },
                body: JSON.stringify({
                    model: DEFAULT_MODEL,
                    messages: messages,
                    max_tokens: 500,
                    temperature: 0.7,
                    top_p: 0.9,
                    stream: false
                })
            });

            console.log('📡 OpenRouter response status:', openRouterResponse.status);

            if (!openRouterResponse.ok) {
                let errorText = '';
                try {
                    const errorData = await openRouterResponse.json();
                    errorText = JSON.stringify(errorData);
                    console.error('❌ OpenRouter error response:', errorText);
                } catch (e) {
                    errorText = await openRouterResponse.text();
                    console.error('❌ OpenRouter error text:', errorText);
                }

                if (openRouterResponse.status === 401) {
                    return sendJson(res, 200, {
                        success: true,
                        response: "I'm having trouble with my AI connection. The API key appears to be invalid. Please contact support. 🙏",
                        source: 'fallback',
                        error: 'AUTH_FAILED'
                    });
                }

                if (openRouterResponse.status === 429) {
                    return sendJson(res, 200, {
                        success: true,
                        response: "I'm getting a lot of requests right now. Please wait a moment and try again. 🙏",
                        source: 'fallback',
                        error: 'RATE_LIMITED'
                    });
                }

                return sendJson(res, 200, {
                    success: true,
                    response: `I'm having trouble connecting to my AI brain right now. 😅 Please try again in a moment.`,
                    source: 'fallback',
                    error: 'API_ERROR',
                    status: openRouterResponse.status
                });
            }

            const openRouterData = await openRouterResponse.json();
            console.log('📡 OpenRouter response received successfully');

            if (openRouterData.choices && openRouterData.choices.length > 0) {
                const aiResponse = openRouterData.choices[0].message.content || '';
                console.log('📡 AI Response length:', aiResponse.length);
                console.log('📡 AI Response preview:', aiResponse.substring(0, 100) + '...');
                return sendJson(res, 200, {
                    success: true,
                    response: aiResponse,
                    source: 'openrouter',
                    model: openRouterData.model || DEFAULT_MODEL
                });
            } else {
                console.error('❌ No choices in OpenRouter response:', JSON.stringify(openRouterData));
                return sendJson(res, 200, {
                    success: true,
                    response: "I apologize, but I'm having trouble formulating a response right now. 🤔 Please try rephrasing your question.",
                    source: 'fallback',
                    error: 'NO_CHOICES'
                });
            }

        } catch (fetchError) {
            console.error('❌ OpenRouter fetch error:', fetchError.message);
            return sendJson(res, 200, {
                success: true,
                response: "Oops! Something went wrong connecting to the AI service. 😅 Please try again in a moment.",
                source: 'fallback',
                error: 'FETCH_ERROR'
            });
        }

    } catch (error) {
        console.error('❌ Support chat error:', error);
        return sendJson(res, 200, {
            success: true,
            response: "Oops! Something went wrong on my end. 😅 Please try again in a moment.",
            source: 'fallback',
            error: 'GENERAL_ERROR'
        });
    }
}

// ========================================
// ========================================
// MAIN HANDLER
// ========================================
// ========================================

module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    console.log(`${req.method} ${req.url}`);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    try {
        // POST /api/payments/initialize
        if (req.method === 'POST' && path === '/api/payments/initialize') {
            await handlePaymentInitialize(req, res);
            return;
        }

        // GET /api/payments/verify
        if (req.method === 'GET' && path === '/api/payments/verify') {
            await handlePaymentVerify(req, res);
            return;
        }

        // GET /api/payments/verify/:reference
        if (req.method === 'GET' && path.startsWith('/api/payments/verify/')) {
            const ref = path.replace('/api/payments/verify/', '');
            req.url = `/api/payments/verify?reference=${encodeURIComponent(ref)}`;
            await handlePaymentVerify(req, res);
            return;
        }

        // GET /api/config/paystack
        if (req.method === 'GET' && path === '/api/config/paystack') {
            await handleConfigPaystack(req, res);
            return;
        }

        // POST /api/support/chat
        if (req.method === 'POST' && path === '/api/support/chat') {
            await handleSupportChat(req, res);
            return;
        }

        // GET /api
        if (req.method === 'GET' && (path === '/api' || path === '/api/')) {
            sendJson(res, 200, {
                success: true,
                name: 'Shop Good API',
                version: '1.0.0',
                endpoints: {
                    'POST /api/payments/initialize': 'Initialize Paystack payment',
                    'GET /api/payments/verify?reference=xxx': 'Verify Paystack payment',
                    'GET /api/payments/verify/:reference': 'Verify Paystack payment (alternative)',
                    'GET /api/config/paystack': 'Get Paystack public key',
                    'POST /api/support/chat': 'Send message to OpenRouter AI assistant (auto-selects best model)',
                    'GET /api': 'This help page'
                },
                environment: {
                    paystackConfigured: !!PAYSTACK_SECRET_KEY,
                    openrouterConfigured: !!OPENROUTER_API_KEY,
                    model: DEFAULT_MODEL
                }
            });
            return;
        }

        sendJson(res, 404, {
            success: false,
            message: `Route not found: ${req.method} ${path}`,
            availableEndpoints: [
                'POST /api/payments/initialize',
                'GET /api/payments/verify?reference=xxx',
                'GET /api/config/paystack',
                'POST /api/support/chat',
                'GET /api'
            ]
        });

    } catch (error) {
        console.error('API error:', error);
        sendJson(res, 500, {
            success: false,
            message: 'Internal server error'
        });
    }
};
