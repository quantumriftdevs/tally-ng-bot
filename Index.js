const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

async function parseMessage(message) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `You are a bookkeeping assistant for Nigerian market traders.
Extract transaction info from this message: "${message}"

Return ONLY a JSON object, nothing else:
{"type": "Sales" or "Expense", "amount": number, "description": "item"}

If unclear return: {"error": "unclear"}`
      }]
    })
  });
  const data = await response.json();
  const text = data.content[0].text;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function saveToSheets(phone, parsed, rawMessage) {
  const date = new Date().toLocaleDateString('en-NG');
  const row = [phone, parsed.description, parsed.amount, parsed.type, date, rawMessage];
  
  await fetch(`https://sheet.best/api/sheets/${process.env.SHEET_BEST_ID}`, {
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
  const message = req.body.Body;
  const from = req.body.From.replace('whatsapp:', '');
  
  res.sendStatus(200);

  try {
    if (message.toLowerCase() === 'summary') {
      await sendReply(from, 
        `📊 *Tally.ng Summary*\n\nSend "today" to see today's records or keep recording transactions!`
      );
      return;
    }

    const parsed = await parseMessage(message);

    if (parsed.error) {
      await sendReply(from,
        `I no understand that one 😅\n\nTry:\n"Sold 3 bags of rice for ₦45,000"\nor\n"Spent ₦5,000 on transport"`
      );
      return;
    }

    await saveToSheets(from, parsed, message);

    const emoji = parsed.type === 'Sales' ? '✅' : '💸';
    await sendReply(from,
      `${emoji} *Recorded!*\n\n*${parsed.type}:* ${parsed.description}\n*Amount:* ₦${Number(parsed.amount).toLocaleString()}\n\nSend another transaction or type *summary* to see your records.`
    );

  } catch (err) {
    console.error(err);
    await sendReply(from, 'Something went wrong, try again 🙏');
  }
});

app.get('/', (req, res) => res.send('Tally.ng bot is running!'));

app.listen(3000, () => console.log('Tally.ng running on port 3000'));
