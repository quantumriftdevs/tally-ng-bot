const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const greetings = ['hello', 'hi', 'hey', 'start', 'help', 'helo', 'hii'];

// Detect if a message is a QUERY (asking for info) vs a TRANSACTION (recording info)
async function classifyMessage(message) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You classify Nigerian market trader WhatsApp messages into one of two types: "transaction" (recording a sale or expense) or "query" (asking about past records, debts, or totals).

Return ONLY JSON, no explanation:
{"intent": "transaction" or "query"}

Examples:
"Sold 5 bags rice ₦45,000" -> {"intent": "transaction"}
"How much did I sell today" -> {"intent": "query"}
"Mama Chioma owes me ₦20,000" -> {"intent": "transaction"}
"How much does Mama Chioma owe me" -> {"intent": "query"}
"What did I sell last week" -> {"intent": "query"}`
        },
        { role: "user", content: message }
      ],
      max_tokens: 50,
      temperature: 0
    })
  });
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  try {
    const match = raw.match(/\{.*\}/s);
    return match ? JSON.parse(match[0]) : { intent: "transaction" };
  } catch {
    return { intent: "transaction" };
  }
}

// Parse a transaction message into structured data
async function parseTransaction(message) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are a bookkeeping assistant for Nigerian market traders. Extract transaction info from messages, including debt/credit sales.

Return ONLY JSON:
{"type": "Sales" or "Expense", "amount": number, "description": "item", "customer": "name or empty string", "isDebt": true or false}

If a sale mentions a customer name and they haven't paid yet (e.g. "she go pay later", "on credit", "owes me"), set isDebt to true and include the customer name.

If unclear return: {"error": "unclear"}`
        },
        { role: "user", content: message }
      ],
      max_tokens: 200,
      temperature: 0.1
    })
  });
  const data = await response.json();
  if (!data.choices?.[0]) return { error: "unclear" };
  const raw = data.choices[0].message.content.trim();
  try {
    const match = raw.match(/\{.*\}/s);
    return match ? JSON.parse(match[0]) : { error: "unclear" };
  } catch {
    return { error: "unclear" };
  }
}

// Parse a query message into a structured filter request
async function parseQuery(message) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You convert a trader's natural language question into a structured query for their transaction records.

Today's date is ${new Date().toLocaleDateString('en-NG')}.

Return ONLY JSON:
{"queryType": "date" or "customer" or "item" or "debt_total" or "general", "customer": "name or empty", "item": "item name or empty", "dateRange": "today" or "this_week" or "this_month" or "all"}

Examples:
"How much did I sell today" -> {"queryType":"date","customer":"","item":"","dateRange":"today"}
"How much does Mama Chioma owe me" -> {"queryType":"customer","customer":"Mama Chioma","item":"","dateRange":"all"}
"How many bags of rice did I sell" -> {"queryType":"item","customer":"","item":"rice","dateRange":"all"}
"Who owes me money" -> {"queryType":"debt_total","customer":"","item":"","dateRange":"all"}
"Show my records this week" -> {"queryType":"date","customer":"","item":"","dateRange":"this_week"}`
        },
        { role: "user", content: message }
      ],
      max_tokens: 150,
      temperature: 0
    })
  });
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  try {
    const match = raw.match(/\{.*\}/s);
    return match ? JSON.parse(match[0]) : { queryType: "general", dateRange: "all" };
  } catch {
    return { queryType: "general", dateRange: "all" };
  }
}

async function saveToSheets(phone, parsed, rawMessage) {
  const date = new Date().toLocaleDateString('en-NG');
  await fetch(`https://api.sheetbest.com/sheets/${process.env.SHEET_BEST_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "Trader Phone": phone,
      "Description": parsed.description,
      "Amount": parsed.amount,
      "Type": parsed.type,
      "Customer": parsed.customer || "",
      "Is Debt": parsed.isDebt ? "Yes" : "No",
      "Date": date,
      "Raw Message": rawMessage
    })
  });
}

async function getAllRecords(phone) {
  const response = await fetch(`https://api.sheetbest.com/sheets/${process.env.SHEET_BEST_ID}/search?Trader Phone=${encodeURIComponent(phone)}`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function isInDateRange(rowDate, range) {
  if (range === 'all') return true;
  const today = new Date();
  const d = new Date(rowDate);
  if (range === 'today') {
    return d.toLocaleDateString('en-NG') === today.toLocaleDateString('en-NG');
  }
  if (range === 'this_week') {
    const weekAgo = new Date();
    weekAgo.setDate(today.getDate() - 7);
    return d >= weekAgo;
  }
  if (range === 'this_month') {
    return d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
  }
  return true;
}

async function handleQuery(phone, query) {
  const records = await getAllRecords(phone);

  if (records.length === 0) {
    return `📊 No records yet. Start by sending a transaction like:\n"Sold 5 bags rice ₦45,000"`;
  }

  // DEBT TOTAL — who owes money
  if (query.queryType === 'debt_total') {
    const debts = records.filter(r => r['Is Debt'] === 'Yes');
    if (debts.length === 0) return `✅ Nobody owes you money right now. Clean books!`;
    
    const byCustomer = {};
    debts.forEach(r => {
      const name = r.Customer || 'Unknown';
      byCustomer[name] = (byCustomer[name] || 0) + Number(r.Amount || 0);
    });
    
    let msg = `💰 *Who owes you:*\n\n`;
    let total = 0;
    for (const [name, amt] of Object.entries(byCustomer)) {
      msg += `• ${name}: ₦${amt.toLocaleString()}\n`;
      total += amt;
    }
    msg += `\n*Total owed:* ₦${total.toLocaleString()}`;
    return msg;
  }

  // CUSTOMER — specific person's balance
  if (query.queryType === 'customer' && query.customer) {
    const matches = records.filter(r => 
      (r.Customer || '').toLowerCase().includes(query.customer.toLowerCase())
    );
    if (matches.length === 0) return `No records found for "${query.customer}".`;
    
    let total = 0;
    let msg = `📋 *Records for ${query.customer}:*\n\n`;
    matches.forEach(r => {
      msg += `• ${r.Description} - ₦${Number(r.Amount).toLocaleString()} (${r['Is Debt'] === 'Yes' ? 'unpaid' : 'paid'})\n`;
      if (r['Is Debt'] === 'Yes') total += Number(r.Amount || 0);
    });
    if (total > 0) msg += `\n*Owes you:* ₦${total.toLocaleString()}`;
    return msg;
  }

  // ITEM — how much of a specific item sold
  if (query.queryType === 'item' && query.item) {
    const matches = records.filter(r =>
      (r.Description || '').toLowerCase().includes(query.item.toLowerCase())
    );
    if (matches.length === 0) return `No records found for "${query.item}".`;
    
    const total = matches.reduce((sum, r) => sum + Number(r.Amount || 0), 0);
    return `📦 *${query.item} records:*\n\n${matches.length} transaction(s)\n*Total:* ₦${total.toLocaleString()}`;
  }

  // DATE — filter by time range (default)
  const filtered = records.filter(r => isInDateRange(r.Date, query.dateRange));
  
  if (filtered.length === 0) {
    return `No records found for that period.`;
  }

  let sales = 0, expenses = 0;
  filtered.forEach(r => {
    const amt = Number(r.Amount || 0);
    if (r.Type === 'Sales') sales += amt;
    else if (r.Type === 'Expense') expenses += amt;
  });

  const rangeLabel = { today: 'Today', this_week: 'This Week', this_month: 'This Month', all: 'All Time' }[query.dateRange] || 'All Time';
  const profit = sales - expenses;

  return `📊 *${rangeLabel} Summary*\n\n✅ Sales: ₦${sales.toLocaleString()}\n💸 Expenses: ₦${expenses.toLocaleString()}\n${profit >= 0 ? '📈' : '📉'} Profit: ₦${profit.toLocaleString()}\n\n${filtered.length} transaction(s)`;
}

async function sendReply(to, message) {
  const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${to}`,
    body: message
  });
}

app.post('/webhook', async (req, res) => {
  const message = req.body.Body.trim();
  const from = req.body.From.replace('whatsapp:', '');
  const lower = message.toLowerCase();

  res.sendStatus(200);

  try {
    if (greetings.includes(lower)) {
      await sendReply(from,
        `👋 *Welcome to Tally.ng!*\n\nI help you track sales, expenses, and customer debts — right here on WhatsApp.\n\n*Record things:*\n✅ "Sold 5 bags rice ₦45,000"\n💸 "Spent ₦3,000 on transport"\n📝 "Sold rice to Mama Chioma ₦20,000, she go pay later"\n\n*Ask me anything:*\n📊 "How much did I sell today"\n💰 "Who owes me money"\n📦 "How many bags of rice did I sell"\n\nLet's start! 🚀`
      );
      return;
    }

    if (lower === 'summary' || lower === 'report') {
      const result = await handleQuery(from, { queryType: 'date', dateRange: 'all' });
      await sendReply(from, result);
      return;
    }

    const classified = await classifyMessage(message);

    if (classified.intent === 'query') {
      const query = await parseQuery(message);
      const result = await handleQuery(from, query);
      await sendReply(from, result);
      return;
    }

    // Default: treat as transaction
    const parsed = await parseTransaction(message);

    if (parsed.error) {
      await sendReply(from,
        `I no understand that one 😅\n\nTry:\n"Sold 3 bags of rice for ₦45,000"\nor ask me:\n"How much did I sell today"`
      );
      return;
    }

    await saveToSheets(from, parsed, message);

    const emoji = parsed.type === 'Sales' ? '✅' : '💸';
    let reply = `${emoji} *Recorded!*\n\n*${parsed.type}:* ${parsed.description}\n*Amount:* ₦${Number(parsed.amount).toLocaleString()}`;
    if (parsed.isDebt && parsed.customer) {
      reply += `\n*Customer:* ${parsed.customer} (unpaid)`;
    }
    reply += `\n\nSend another or ask "how much did I sell today".`;

    await sendReply(from, reply);

  } catch (err) {
    console.error('Webhook error:', err);
    await sendReply(from, 'Something went wrong, try again 🙏');
  }
});

app.get('/', (req, res) => res.send('Tally.ng bot is running!'));

app.listen(3000, () => console.log('Tally.ng running on port 3000'));
