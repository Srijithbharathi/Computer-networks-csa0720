require("dotenv").config();
const express=require("express"),cors=require("cors"),helmet=require("helmet"),crypto=require("crypto"),bcrypt=require("bcryptjs"),jwt=require("jsonwebtoken"),Razorpay=require("razorpay"),{z}=require("zod"),{PrismaClient}=require("@prisma/client"),path=require("path");
const app=express(),prisma=new PrismaClient();
app.set("trust proxy",1); app.use(helmet({crossOriginResourcePolicy:false})); app.use(cors({origin:process.env.APP_URL||true,credentials:true}));

function safeEqual(a,b){const x=Buffer.from(a||""),y=Buffer.from(b||"");return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function requireEnv(name){if(!process.env[name])throw new Error(name+" not configured");}
function auth(req,res,next){try{req.user=jwt.verify((req.headers.authorization||"").replace(/^Bearer /,""),process.env.JWT_SECRET);next()}catch{res.status(401).json({error:"Authentication required"})}}
function admin(req,res,next){if(req.user?.role!=="ADMIN")return res.status(403).json({error:"Admin only"});next()}

async function creditPayment(orderId,paymentId){
  return prisma.$transaction(async tx=>{
    const p=await tx.payment.findUnique({where:{razorpayOrderId:orderId}});
    if(!p)return null;
    if(p.status==="PAID")return p;
    const rate=Number(process.env.USD_PER_INR_RATE||0.011);
    const usd=Number(p.amountInr||0)*rate;
    const updated=await tx.payment.update({where:{id:p.id},data:{status:"PAID",razorpayPaymentId:paymentId,amountUsd:usd}});
    const u=await tx.user.update({where:{id:p.userId},data:{balanceUsd:{increment:usd}}});
    await tx.walletTransaction.create({data:{userId:p.userId,paymentId:p.id,type:"CREDIT",amountUsd:usd,balanceAfter:u.balanceUsd,reference:"payment:"+p.id}});
    return updated;
  });
}

app.post("/api/payments/razorpay/webhook",express.raw({type:"application/json"}),async(req,res)=>{
  try{
    requireEnv("RAZORPAY_WEBHOOK_SECRET");
    const sig=req.header("x-razorpay-signature")||"";
    const exp=crypto.createHmac("sha256",process.env.RAZORPAY_WEBHOOK_SECRET).update(req.body).digest("hex");
    if(!safeEqual(sig,exp))return res.status(400).json({error:"Invalid signature"});
    const e=JSON.parse(req.body.toString("utf8")),p=e.payload?.payment?.entity;
    if(e.event==="payment.captured"&&p?.order_id)await creditPayment(p.order_id,p.id);
    return res.json({ok:true});
  }catch(err){console.error(err);return res.status(400).json({error:"Invalid webhook"})}
});

app.use(express.json({limit:"1mb"})); app.use(express.static(path.join(process.cwd(),"public")));
app.get("/api/health",async(_,res)=>{try{await prisma.$queryRaw`SELECT 1`;res.json({ok:true,service:"AI Compute Cloud",database:"ok"})}catch{res.status(503).json({ok:false,service:"AI Compute Cloud",database:"error"})}});

app.post("/api/auth/register",async(req,res)=>{try{const b=z.object({name:z.string().min(2).max(80),email:z.string().email().max(160),password:z.string().min(8).max(128)}).parse(req.body),email=b.email.toLowerCase();if(await prisma.user.findUnique({where:{email}}))return res.status(409).json({error:"Email already registered"});const u=await prisma.user.create({data:{name:b.name,email,passwordHash:await bcrypt.hash(b.password,12)}});res.status(201).json({id:u.id,email:u.email})}catch{res.status(400).json({error:"Invalid registration data"})}});
app.post("/api/auth/login",async(req,res)=>{try{requireEnv("JWT_SECRET");const b=z.object({email:z.string().email(),password:z.string()}).parse(req.body),u=await prisma.user.findUnique({where:{email:b.email.toLowerCase()}});if(!u||!(await bcrypt.compare(b.password,u.passwordHash)))return res.status(401).json({error:"Invalid email or password"});res.json({token:jwt.sign({id:u.id,role:u.role,email:u.email},process.env.JWT_SECRET,{expiresIn:"7d"})})}catch{res.status(400).json({error:"Invalid login"})}});

app.get("/api/gpus",async(_,res)=>res.json(await prisma.gpuProduct.findMany({where:{active:true},orderBy:{priceUsdPerHour:"asc"}})));
app.get("/api/me",auth,async(req,res)=>res.json(await prisma.user.findUnique({where:{id:req.user.id},select:{id:true,name:true,email:true,role:true,balanceUsd:true,createdAt:true}})));

app.post("/api/payments/order",auth,async(req,res)=>{
  try{
    requireEnv("RAZORPAY_KEY_ID");requireEnv("RAZORPAY_KEY_SECRET");
    const {amountInr}=z.object({amountInr:z.number().int().min(100).max(1000000)}).parse(req.body);
    const rp=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
    const receipt="acc_"+crypto.randomUUID();
    const o=await rp.orders.create({amount:amountInr*100,currency:"INR",receipt});
    await prisma.payment.create({data:{userId:req.user.id,amountInr,amountUsd:0,razorpayOrderId:o.id}});
    res.json({orderId:o.id,amount:o.amount,currency:o.currency,keyId:process.env.RAZORPAY_KEY_ID});
  }catch(e){console.error(e);res.status(400).json({error:"Could not create payment order"})}
});

app.post("/api/payments/verify",auth,async(req,res)=>{
  try{
    requireEnv("RAZORPAY_KEY_SECRET");
    const b=z.object({razorpay_order_id:z.string(),razorpay_payment_id:z.string(),razorpay_signature:z.string()}).parse(req.body);
    const exp=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(b.razorpay_order_id+"|"+b.razorpay_payment_id).digest("hex");
    if(!safeEqual(exp,b.razorpay_signature))return res.status(400).json({error:"Invalid payment signature"});
    const p=await prisma.payment.findFirst({where:{razorpayOrderId:b.razorpay_order_id,userId:req.user.id}});
    if(!p)return res.status(404).json({error:"Payment not found"});
    await creditPayment(b.razorpay_order_id,b.razorpay_payment_id);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(400).json({error:"Payment verification failed"})}
});

app.post("/api/jobs",auth,async(req,res)=>{
  try{
    const b=z.object({gpuProductId:z.string(),requestedHours:z.number().positive().max(Number(process.env.MAX_JOB_HOURS||12))}).parse(req.body);
    const gpu=await prisma.gpuProduct.findUnique({where:{id:b.gpuProductId}});
    if(!gpu||!gpu.active)return res.status(404).json({error:"GPU unavailable"});
    const cost=Number(gpu.priceUsdPerHour)*b.requestedHours;
    const job=await prisma.$transaction(async tx=>{
      const user=await tx.user.findUnique({where:{id:req.user.id}});
      if(!user||Number(user.balanceUsd)<cost)throw new Error("INSUFFICIENT");
      const updated=await tx.user.update({where:{id:user.id},data:{balanceUsd:{decrement:cost}}});
      const created=await tx.job.create({data:{userId:user.id,gpuProductId:gpu.id,requestedHours:b.requestedHours,estimatedCostUsd:cost,status:"PENDING"}});
      await tx.walletTransaction.create({data:{userId:user.id,jobId:created.id,type:"DEBIT",amountUsd:-cost,balanceAfter:updated.balanceUsd,reference:"job:"+created.id}});
      return created;
    });
    res.status(201).json({job,message:"Job accepted and reserved. RunPod provisioning is enabled only when the server has valid RunPod credentials and a configured provider policy."});
  }catch(e){res.status(e.message==="INSUFFICIENT"?402:400).json({error:e.message==="INSUFFICIENT"?"Insufficient balance. Add funds first.":"Invalid job request"})}
});

app.get("/api/jobs",auth,async(req,res)=>res.json(await prisma.job.findMany({where:{userId:req.user.id},include:{gpuProduct:true},orderBy:{createdAt:"desc"}})));
app.get("/api/wallet/transactions",auth,async(req,res)=>res.json(await prisma.walletTransaction.findMany({where:{userId:req.user.id},orderBy:{createdAt:"desc"},take:100})));
app.get("/api/admin/summary",auth,admin,async(_,res)=>{const [users,jobs,payments,gpus]=await Promise.all([prisma.user.count(),prisma.job.count(),prisma.payment.aggregate({_sum:{amountInr:true}}),prisma.gpuProduct.count({where:{active:true}})]);res.json({users,jobs,paymentsInr:payments._sum.amountInr||0,activeGpuProducts:gpus})});

app.get(/.*/,(_,res)=>res.sendFile(path.join(process.cwd(),"public","index.html")));
const port=Number(process.env.PORT||8080);app.listen(port,()=>console.log("AI Compute Cloud listening on "+port));
