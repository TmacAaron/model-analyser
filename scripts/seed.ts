import { mkdir,writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
const formula=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'builtin:formula:gemm-operations',revision:1,name:'GEMM 运算量',tags:['gemm'],parameters:[],sources:[{kind:'note',text:'一次乘加计两次运算；C01 手算基线'}],
  definition:{kind:'formula',formula:{inputs:Object.fromEntries(['M','N','K'].map(k=>[k,{unit:'count',integerRequired:true,min:1}])),expression:'2 * M * N * K',output:{unit:'operation',integerRequired:false,nonNegative:true},description:'数学运算次数，与存储位宽分开计量'}}});
await mkdir('assets/builtin/formula',{recursive:true});await writeFile('assets/builtin/formula/gemm.json',JSON.stringify(formula,null,2)+'\n');
