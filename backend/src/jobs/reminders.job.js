const prisma=require('../config/prisma');

async function processReminders(){
  const due=await prisma.reminder.findMany({where:{status:'PENDING',scheduledFor:{lte:new Date()}},take:100});
  for(const reminder of due){
    try{
      // Provider adapters (SMS/email/push) should be plugged in here.
      console.log(`[REMINDER] ${reminder.channel}: ${reminder.title}`);
      await prisma.reminder.update({where:{id:reminder.id},data:{status:'SENT'}});
    }catch(e){await prisma.reminder.update({where:{id:reminder.id},data:{status:'FAILED'}})}
  }
}
module.exports={processReminders};
