const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const greetings = ['hello', 'hi', 'hey', 'start', 'help', 'helo', 'hii'];

async function parseMessage(message) {
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
          content: `You are a bookkeeping assistant for Nigerian market traders. Extract transaction info from user messages. Return ONLY a JSON object, no explanation, no markdown, no backticks. Format: {"type": "Sales" or "Expense", "amount": number, "description": "item"}. If unclear return: {"error": "unclear"}`
        },
        {
          role: "user",
          content: message
        }
      ],
      max_tokens: 200,
      temperature: 0.1
    })
  });

  const data = await response.json();

  if (!data.choices || !data.choices[0]) {
    console.error('Groq error:', JSON.stringify(data));
    return { error: "unclear" };
  }

  const raw = data.choices[0].message.content.trim();
  console.log('Groq raw response:', raw);

  try {
    const jsonMatch = raw.match(/\{.*\}/s);
    if (!jsonMatch) return { error: "unclear" };
    return JSON.parse(jsonMatch[0]);
  } catch(e) {
    console.error('Parse error:', raw);
    return { error: "unclear" };
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
      "Date": date,
      "Raw Message": rawMessage
    })
  });
}

async function getWeeklySummary(phone) {
  const response = await fetch(`https://api.sheetbest.com/sheets/${process.env.SHEET_BEST_ID}/search?Trader Phone=${encodeURIComponent(phone)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  const data = await response.json();

  if (!data || data.length === 0) {
    return `📊 *Tally.ng Weekly Summary*\n\nNo transactions recorded yet.\n\nStart by sending your sales like:\n"Sold 5 bags rice ₦45,000"`;
  }

  let totalSales = 0;
  let totalExpenses = 0;
  let salesCount = 0;
  let expensesCount = 0;

  data.forEach(row => {
    const amount = Number(row.Amount) || 0;
    if (row.Type === 'Sales') {
      totalSales += amount;
      salesCount++;
    } else if (row.Type === 'Expense') {
      totalExpenses += amount;
      expensesCount++;
    }
  });

  const profit = totalSales - totalExpenses;
  const profitEmoji = profit >= 0 ? '📈' : '📉';

  return `📊 *Tally.ng Summary*\n\n✅ *Sales:* ₦${totalSales.toLocaleString()} (${salesCount} transactions)\n💸 *Expenses:* ₦${totalExpenses.toLocaleString()} (${expensesCount} transactions)\n${profitEmoji} *Profit:* ₦${profit.toLocaleString()}\n\nKeep recording to track your business! 💪`;
}

async function sendReply(to, message) {
  const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
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
    // Greeting handler
    if (greetings.includes(lower)) {
      await sendReply(from,
        `👋 *Welcome to Tally.ng!*\n\nI help you track your business sales and expenses — no app needed, just WhatsApp.\n\n*How to use me:*\n✅ Record a sale: "Sold 5 bags of rice for ₦45,000"\n💸 Record expense: "Spent ₦3,000 on transport"\n📊 See your summary: type *summary*\n\nLet's start! Send your first transaction. 🚀`
      );
      return;
    }

    // Summary handler
    if (lower === 'summary' || lower === 'report') {
      const summary = await getWeeklySummary(from);
      await sendReply(from, summary);
      return;
    }

    // Transaction handler
    const parsed = await parseMessage(message);

    if (parsed.error) {
      await sendReply(from,
        `I no understand that one 😅\n\nTry:\n"Sold 3 bags of rice for ₦45,000"\nor\n"Spent ₦5,000 on transport"\n\nType *help* to see all commands.`
      );
      return;
    }

    await saveToSheets(from, parsed, message);

    const emoji = parsed.type === 'Sales' ? '✅' : '💸';
    await sendReply(from,
      `${emoji} *Recorded!*\n\n*${parsed.type}:* ${parsed.description}\n*Amount:* ₦${Number(parsed.amount).toLocaleString()}\n\nSend another or type *summary* to see your totals.`
    );

  } catch (err) {
    console.error('Webhook error:', err);
    await sendReply(from, 'Something went wrong, try again 🙏');
  }
});

app.get('/', (req, res) => res.send('Tally.ng bot is running!'));

app.listen(3000, () => console.log('Tally.ng running on port 3000'));
