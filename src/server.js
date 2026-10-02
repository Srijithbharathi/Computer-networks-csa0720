require("dotenv").config();
const express=require("express"),cors=require("cors"),helmet=require("helmet"),crypto=require("crypto"),bcrypt=require("bcryptjs"),jwt=require("jsonwebtoken"),Razorpay=require("razorpay"),{z}=require("zod"),{PrismaClient}=require("@prisma/client"),path=require("path");
const app=express(),prisma=new PrismaClient();
app.set("trust proxy",1);
app.use(helmet({crossOriginResourcePolicy:false,contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'","https://checkout.razorpay.com"],scriptSrcAttr:["'unsafe-inline'"],connectSrc:["'self'","https://api.razorpay.com"],frameSrc:["'self'","https://api.razorpay.com","https://checkout.razorpay.com"],imgSrc:["'self'","data:","https:"],styleSrc:["'self'","'unsafe-inline'"]}}}));
app.use(cors({origin:process.env.APP_URL||true,credentials:true}));

function safeEqual(a,b){const x=Buffer.from(a||""),y=Buffer.from(b||"");return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function requireEnv(name){if(!process.env[name])throw new Error(name+" not configured")}
function auth(req,res,next){try{req.user=jwt.verify((req.headers.authorization||"").replace(/^Bearer /,""),process.env.JWT_SECRET);next()}catch{res.status(401).json({error:"Authentication required"})}}
function admin(req,res,next){if(req.user?.role!=="ADMIN")return res.status(403).json({error:"Admin only"});next()}
function usd(n){return Number(Number(n).toFixed(4))}
async function creditPayment(orderId,paymentId){
  return prisma.$transaction(async tx=>{
    const p=await tx.payment.findUnique({where:{razorpayOrderId:orderId}});
    if(!p)return null;
    const changed=await tx.payment.updateMany({where:{id:p.id,status:{not:"PAID"}},data:{status:"PAID",razorpayPaymentId:paymentId,amountUsd:usd(Number(p.amountInr||0)*Number(process.env.USD_PER_INR_RATE||0.011))}});
    if(changed.count===0)return tx.payment.findUnique({where:{id:p.id}});
    const paid=await tx.payment.findUnique({where:{id:p.id}});
    const amount=Number(paid.amountUsd);
    const u=await tx.user.update({where:{id:p.userId},data:{balanceUsd:{increment:amount}}});
    await tx.walletTransaction.create({data:{userId:p.userId,paymentId:p.id,type:"CREDIT",amountUsd:amount,balanceAfter:u.balanceUsd,reference:"payment:"+p.id}});
    return paid;
  });
}
async function refundJob(jobId,reason){
  return prisma.$transaction(async tx=>{
    const job=await tx.job.findUnique({where:{id:jobId}});
    if(!job)return null;
    const existing=await tx.walletTransaction.findFirst({where:{jobId,type:"REFUND"}});
    if(existing)return job;
    const u=await tx.user.update({where:{id:job.userId},data:{balanceUsd:{increment:job.estimatedCostUsd}}});
    await tx.walletTransaction.create({data:{userId:job.userId,jobId,type:"REFUND",amountUsd:Number(job.estimatedCostUsd),balanceAfter:u.balanceUsd,reference:"refund:"+job.id}});
    return tx.job.update({where:{id:job.id},data:{status:"FAILED"}});
  });
}
async function runpod(query,variables){
  requireEnv("RUNPOD_API_KEY");
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),Number(process.env.RUNPOD_API_TIMEOUT_MS||25000));
  try{
    const r=await fetch(process.env.RUNPOD_GRAPHQL_URL||"https://api.runpod.io/graphql",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+process.env.RUNPOD_API_KEY},body:JSON.stringify({query,variables}),signal:controller.signal});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d.errors?.length){
      const msg=d.errors?.map(e=>e?.message).filter(Boolean).join("; ")||"RunPod API request failed";
      const err=new Error(msg);err.providerStatus=r.status;throw err;
    }
    return d.data;
  }catch(e){
    if(e?.name==="AbortError")throw new Error("RunPod API timeout");
    throw e;
  }finally{clearTimeout(timeout)}
}
async function findGpuType(name){
  const data=await runpod(`query { gpuTypes { id displayName memoryInGb communityCloud secureCloud } }`,{});
  const list=data.gpuTypes||[];
  const norm=s=>String(s||"").toLowerCase().replace(/nvidia|gpu|graphics|\s+/g,"");
  const target=norm(name);
  let g=list.find(x=>norm(x.displayName)===target);
  if(!g)g=list.find(x=>target.includes(norm(x.displayName))||norm(x.displayName).includes(target));
  if(!g){
    const key=target.replace(/80gb|hbm3|pcie|sxmtime|-/g,"");
    g=list.find(x=>norm(x.displayName).includes(key)||key.includes(norm(x.displayName)));
  }
  if(!g)throw new Error("No matching RunPod GPU type for "+name);
  return g;
}
async function provisionJob(job,gpu){
  const gpuType=await findGpuType(gpu.name);
  const primaryCloud=(process.env.RUNPOD_CLOUD_TYPE||"COMMUNITY").toUpperCase();
  const primaryAvailable=primaryCloud==="COMMUNITY"?gpuType.communityCloud:gpuType.secureCloud;
  if(primaryAvailable===false)throw new Error("GPU is unavailable on the selected RunPod cloud tier");
  const terminateAfter=new Date(Date.now()+Number(job.requestedHours)*3600000).toISOString();
  const mutation=`mutation deploy($input: PodFindAndDeployOnDemandInput){podFindAndDeployOnDemand(input:$input){id name desiredStatus costPerHr imageName}}`;
  const input={
    name:"acc-"+job.id,
    cloudType:process.env.RUNPOD_CLOUD_TYPE||"COMMUNITY",
    gpuTypeId:gpuType.id,
    gpuCount:1,
    imageName:process.env.RUNPOD_IMAGE_NAME||"runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04",
    containerDiskInGb:Number(process.env.RUNPOD_CONTAINER_DISK_GB||30),
    volumeInGb:Number(process.env.RUNPOD_VOLUME_GB||0),
    volumeMountPath:process.env.RUNPOD_VOLUME_MOUNT||"/workspace",
    terminateAfter,
    supportPublicIp:((process.env.RUNPOD_CLOUD_TYPE||"COMMUNITY").toUpperCase()==="COMMUNITY"),
    computeType:"GPU"
  };
  try{
    const data=await runpod(mutation,{input});
    if(!data.podFindAndDeployOnDemand?.id)throw new Error("RunPod did not return a pod");
    return data.podFindAndDeployOnDemand;
  }catch(firstError){
    const fallback=(process.env.RUNPOD_FALLBACK_CLOUD_TYPE||"").toUpperCase();
    const capacity=/no longer any instances available|no instances available|requested specifications|unavailable/i.test(String(firstError?.message||""));
    if(!fallback||fallback===primaryCloud||!capacity)throw firstError;
    const fallbackAvailable=fallback==="COMMUNITY"?gpuType.communityCloud:gpuType.secureCloud;
    if(fallbackAvailable===false)throw firstError;
    const fallbackInput={...input,cloudType:fallback};
    const data=await runpod(mutation,{input:fallbackInput});
    if(!data.podFindAndDeployOnDemand?.id)throw new Error("RunPod did not return a pod");
    return data.podFindAndDeployOnDemand;
  }
}
async function podInfo(id){
  const data=await runpod(`query pod($input:PodFilter){pod(input:$input){id name desiredStatus imageName costPerHr uptimeSeconds}}`,{input:{podId:id}});
  return data.pod;
}
async function terminatePod(id){
  return runpod(`mutation podTerminate($input:PodTerminateInput!){podTerminate(input:$input)}`,{input:{podId:id}});
}
async function reconcileStoppedJob(job){
  if(!job||!["STOPPED","FAILED"].includes(job.status))return job;
  const existing=await prisma.walletTransaction.findFirst({where:{jobId:job.id,type:"REFUND"}});
  if(existing)return job;
  const elapsed=job.startedAt?Math.max(0,(Date.now()-new Date(job.startedAt).getTime())/3600000):0;
  const used=usd(Math.min(Number(job.requestedHours),elapsed)*Number(job.estimatedCostUsd)/Number(job.requestedHours));
  const refund=usd(Math.max(0,Number(job.estimatedCostUsd)-used));
  if(refund<=0)return job;
  return prisma.$transaction(async tx=>{
    const u=await tx.user.update({where:{id:job.userId},data:{balanceUsd:{increment:refund}}});
    await tx.walletTransaction.create({data:{userId:job.userId,jobId:job.id,type:"REFUND",amountUsd:refund,balanceAfter:u.balanceUsd,reference:"reconcile-refund:"+job.id}});
    return tx.job.update({where:{id:job.id},data:{status:"STOPPED"}});
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
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(process.cwd(),"public")));

app.get("/api/health",async(_,res)=>{try{await prisma.$queryRaw`SELECT 1`;res.json({ok:true,service:"AI Compute Cloud",database:"ok",payments:!!process.env.RAZORPAY_KEY_ID,gpuProvider:!!process.env.RUNPOD_API_KEY})}catch{res.status(503).json({ok:false,service:"AI Compute Cloud",database:"error"})}});

app.post("/api/auth/register",async(req,res)=>{try{const b=z.object({name:z.string().min(2).max(80),email:z.string().email().max(160),password:z.string().min(8).max(128)}).parse(req.body),email=b.email.toLowerCase();if(await prisma.user.findUnique({where:{email}}))return res.status(409).json({error:"Email already registered"});const u=await prisma.user.create({data:{name:b.name,email,passwordHash:await bcrypt.hash(b.password,12)}});res.status(201).json({id:u.id,email:u.email})}catch{res.status(400).json({error:"Invalid registration data"})}});
app.post("/api/auth/login",async(req,res)=>{try{requireEnv("JWT_SECRET");const b=z.object({email:z.string().email(),password:z.string()}).parse(req.body),u=await prisma.user.findUnique({where:{email:b.email.toLowerCase()}});if(!u||!(await bcrypt.compare(b.password,u.passwordHash)))return res.status(401).json({error:"Invalid email or password"});res.json({token:jwt.sign({id:u.id,role:u.role,email:u.email},process.env.JWT_SECRET,{expiresIn:"7d"})})}catch{res.status(400).json({error:"Invalid login"})}});

app.get("/api/gpus",async(_,res)=>res.json(await prisma.gpuProduct.findMany({where:{active:true},orderBy:{priceUsdPerHour:"asc"}})));
app.get("/api/me",auth,async(req,res)=>res.json(await prisma.user.findUnique({where:{id:req.user.id},select:{id:true,name:true,email:true,role:true,balanceUsd:true,createdAt:true}})));

app.post("/api/payments/order",auth,async(req,res)=>{
  try{
    requireEnv("RAZORPAY_KEY_ID");requireEnv("RAZORPAY_KEY_SECRET");
    const {amountInr}=z.object({amountInr:z.number().int().min(100).max(1000000)}).parse(req.body);
    const rp=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
    const o=await rp.orders.create({amount:amountInr*100,currency:"INR",receipt:"acc_"+crypto.randomUUID()});
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
    const rp=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
    const remote=await rp.payments.fetch(b.razorpay_payment_id);
    if(remote?.order_id!==p.razorpayOrderId||remote?.currency!=="INR"||Number(remote?.amount)!==Number(p.amountInr)*100||remote?.status!=="captured")return res.status(400).json({error:"Payment is not captured or does not match the order"});
    await creditPayment(b.razorpay_order_id,b.razorpay_payment_id);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(400).json({error:"Payment verification failed"})}
});

app.post("/api/jobs",auth,async(req,res)=>{
  try{
    requireEnv("RUNPOD_API_KEY");
    const b=z.object({gpuProductId:z.string(),requestedHours:z.number().positive().max(Number(process.env.MAX_JOB_HOURS||12))}).parse(req.body);
    const gpu=await prisma.gpuProduct.findUnique({where:{id:b.gpuProductId}});
    if(!gpu||!gpu.active)return res.status(404).json({error:"GPU unavailable"});
    const cost=usd(Number(gpu.priceUsdPerHour)*b.requestedHours);
    const job=await prisma.$transaction(async tx=>{
      const user=await tx.user.findUnique({where:{id:req.user.id}});
      if(!user||Number(user.balanceUsd)<cost)throw new Error("INSUFFICIENT");
      const updated=await tx.user.update({where:{id:user.id},data:{balanceUsd:{decrement:cost}}});
      const created=await tx.job.create({data:{userId:user.id,gpuProductId:gpu.id,requestedHours:b.requestedHours,estimatedCostUsd:cost,status:"PROVISIONING"}});
      await tx.walletTransaction.create({data:{userId:user.id,jobId:created.id,type:"DEBIT",amountUsd:-cost,balanceAfter:updated.balanceUsd,reference:"job:"+created.id+":debit"}});
      return created;
    });
    try{
      const pod=await provisionJob(job,gpu);
      const updated=await prisma.job.update({where:{id:job.id},data:{providerJobId:pod.id,status:pod.desiredStatus==="RUNNING"?"RUNNING":"PROVISIONING",startedAt:pod.desiredStatus==="RUNNING"?new Date():null}});
      return res.status(201).json({job:updated,provider:{id:pod.id,name:pod.name,status:pod.desiredStatus}});
    }catch(e){
      console.error("[RUNPOD_PROVISION_FAILED]", JSON.stringify({jobId:job.id,gpu:gpu.name,message:e?.message||String(e),stack:e?.stack||null}));
      try{await refundJob(job.id,e.message);}catch(refundError){console.error("[RUNPOD_REFUND_FAILED]", JSON.stringify({jobId:job.id,message:refundError?.message||String(refundError)}));}
      const msg=String(e?.message||"");
      const unavailable=/no longer any instances available|no instances available|requested specifications|unavailable/i.test(msg);
      const billing=/insufficient|balance|payment|credit/i.test(msg);
      const authError=/unauthorized|forbidden|api key|authentication/i.test(msg);
      const timeout=/timeout/i.test(msg);
      return res.status(502).json({error:unavailable?"GPU is temporarily unavailable on the selected RunPod cloud tier. Your reserved wallet balance was restored.":billing?"The GPU provider requires available RunPod billing credit. Your reserved wallet balance was restored.":authError?"The GPU provider credentials are not accepted. Your reserved wallet balance was restored.":timeout?"The GPU provider timed out before the GPU could be confirmed. Your reserved wallet balance was restored.":"GPU provisioning failed; your reserved wallet balance was restored."});
    }
  }catch(e){
    if(e.message==="INSUFFICIENT")return res.status(402).json({error:"Insufficient balance. Add funds first."});
    console.error(e);res.status(400).json({error:e.message||"Invalid job request"});
  }
});
app.get("/api/jobs",auth,async(req,res)=>res.json(await prisma.job.findMany({where:{userId:req.user.id},include:{gpuProduct:true,transactions:true},orderBy:{createdAt:"desc"}})));
app.get("/api/jobs/:id",auth,async(req,res)=>{
  try{
    const job=await prisma.job.findFirst({where:{id:req.params.id,userId:req.user.id},include:{gpuProduct:true,transactions:true}});
    if(!job)return res.status(404).json({error:"Job not found"});
    if(job.providerJobId&&process.env.RUNPOD_API_KEY&&["PROVISIONING","RUNNING","STOPPING"].includes(job.status)){
      try{
        const p=await podInfo(job.providerJobId);
        let status=job.status;
        if(["RUNNING"].includes(p?.desiredStatus))status="RUNNING";
        else if(["TERMINATED","DEAD","EXITED"].includes(p?.desiredStatus))status="STOPPED";
        if(status!==job.status)await prisma.job.update({where:{id:job.id},data:{status,startedAt:status==="RUNNING"&&!job.startedAt?new Date():job.startedAt,stoppedAt:status==="STOPPED"?new Date():job.stoppedAt}});
        if(status==="STOPPED")await reconcileStoppedJob({...job,status});
      }catch{}
    }
    return res.json(await prisma.job.findUnique({where:{id:job.id},include:{gpuProduct:true,transactions:true}}));
  }catch{res.status(400).json({error:"Could not read job"})}
});
app.post("/api/jobs/:id/stop",auth,async(req,res)=>{
  try{
    const job=await prisma.job.findFirst({where:{id:req.params.id,userId:req.user.id}});
    if(!job)return res.status(404).json({error:"Job not found"});
    if(!job.providerJobId)return res.status(400).json({error:"Provider job is not available"});
    if(["STOPPED","FAILED"].includes(job.status))return res.json({job});
    await prisma.job.update({where:{id:job.id},data:{status:"STOPPING"}});
    try{await terminatePod(job.providerJobId)}catch(e){await prisma.job.update({where:{id:job.id},data:{status:job.status}});throw e}
    const elapsed=job.startedAt?Math.max(0,(Date.now()-new Date(job.startedAt).getTime())/3600000):0;
    const used=usd(Math.min(Number(job.requestedHours),elapsed)*Number(job.estimatedCostUsd)/Number(job.requestedHours));
    const refund=usd(Number(job.estimatedCostUsd)-used);
    const updated=await prisma.$transaction(async tx=>{
      const j=await tx.job.update({where:{id:job.id},data:{status:"STOPPED",stoppedAt:new Date()}});
      if(refund>0){
        const u=await tx.user.update({where:{id:job.userId},data:{balanceUsd:{increment:refund}}});
        await tx.walletTransaction.create({data:{userId:job.userId,jobId:job.id,type:"REFUND",amountUsd:refund,balanceAfter:u.balanceUsd,reference:"stop-refund:"+job.id}});
      }
      return j;
    });
    res.json({job:updated,refundUsd:refund});
  }catch(e){console.error(e);res.status(502).json({error:"Could not stop GPU job"})}
});
app.get("/api/wallet/transactions",auth,async(req,res)=>res.json(await prisma.walletTransaction.findMany({where:{userId:req.user.id},orderBy:{createdAt:"desc"},take:100})));
app.get("/api/admin/summary",auth,admin,async(_,res)=>{const [users,jobs,payments,gpus,balance]=await Promise.all([prisma.user.count(),prisma.job.count(),prisma.payment.aggregate({_sum:{amountInr:true}}),prisma.gpuProduct.count({where:{active:true}}),prisma.user.aggregate({_sum:{balanceUsd:true}})]);res.json({users,jobs,paymentsInr:payments._sum.amountInr||0,customerBalancesUsd:balance._sum.balanceUsd||0,activeGpuProducts:gpus})});

app.get(/.*/,(_,res)=>res.sendFile(path.join(process.cwd(),"public","index.html")));
const port=Number(process.env.PORT||8080);app.listen(port,()=>console.log("AI Compute Cloud listening on "+port));

// Deployment sync check
