const {PrismaClient}=require("@prisma/client");const prisma=new PrismaClient();
async function main(){const products=[["h100","NVIDIA H100",80,3.2],["h200","NVIDIA H200",141,3.8],["a100-80gb","NVIDIA A100 80GB",80,1.8],["l40s","NVIDIA L40S",48,1.1],["l4","NVIDIA L4",24,.65],["b200","NVIDIA B200",180,5]];
for(const [slug,name,memoryGb,priceUsdPerHour] of products)await prisma.gpuProduct.upsert({where:{slug},update:{name,memoryGb,priceUsdPerHour},create:{slug,name,memoryGb,priceUsdPerHour}})}
main().finally(()=>prisma.$disconnect());