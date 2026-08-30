require('dotenv').config();
const app=require('./app');
const {processReminders}=require('./jobs/reminders.job');
const port=Number(process.env.PORT||4000);
app.listen(port,()=>console.log(`Church Management API listening on http://localhost:${port}`));
setInterval(()=>processReminders().catch(console.error),60*1000);
