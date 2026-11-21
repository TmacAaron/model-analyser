import type { AssetDocument } from '@model-analyser/contracts';

type Step = { label: string; equation: string };
type Algorithm = { name: string; steps: Step[] };

function rmsNorm(axis: string, epsilon: string, offsetScale=false): Algorithm {
  return {
    name: 'RMSNorm',
    steps: [
      { label: '沿' + axis + '用 FP32 求均方', equation: 'm = mean(x²)' },
      { label: '计算归一化系数', equation: 'r = rsqrt(m + ε),  ε = ' + epsilon },
      { label: '应用学习得到的缩放权重', equation: offsetScale?'y = (x · r) ⊙ (1 + γ)':'y = (x · r) ⊙ γ' },
    ],
  };
}

function rope(family: 'qwen' | 'deepseek' | 'glm' | 'qwen-hybrid'): Algorithm {
  const splitHalves = family === 'qwen'||family==='qwen-hybrid';
  const steps = [
    { label: family==='qwen-hybrid'?'在每个 Q/K head 的旋转前缀内按两半配对':splitHalves?'将每个 Q/K head 的前后两半配对':family === 'deepseek'
      ? '仅将 MLA 的 Q 位置分量和共享 K 位置分量按相邻维度配对' : '将 Q/K 前半个 head 的相邻维度配对',
      equation: family==='qwen-hybrid'?'(a, b) = (x[j], x[j + R/2])':splitHalves?'(a, b) = (x[j], x[j + D/2])':'(a, b) = (x[2j], x[2j+1])' },
    { label: family === 'deepseek' ? '读取当前 token 位置的 YaRN 旋转系数' : '读取当前 token 位置的旋转系数',
      equation: '(c, s) = (cos θ[p, j], sin θ[p, j])' },
    { label: '应用二维旋转', equation: '(a′, b′) = (ac − bs, as + bc)' },
  ];
  if (family!=='qwen') steps.push({ label: '其余维度直接保留', equation: 'y_pass = x_pass' });
  return { name: family === 'deepseek' ? 'YaRN RoPE' : 'RoPE', steps };
}

const recurrence:Algorithm={
  name:'Gated DeltaNet',
  steps:[
    {label:'对上一步的矩阵状态应用衰减',equation:'S̃ₜ = exp(gₜ) · Sₜ₋₁'},
    {label:'按当前键读取记忆并计算修正量',equation:'δₜ = βₜ · (vₜ − kₜᵀ · S̃ₜ)'},
    {label:'将修正写回状态',equation:'Sₜ = S̃ₜ + kₜ · δₜᵀ'},
    {label:'按当前查询读取更新后的状态',equation:'oₜ = qₜᵀ · Sₜ'},
  ],
};

function deepSeekV4Algorithm(localId:string,v41=false,ratio='4'):Algorithm|undefined {
  if(localId.endsWith('-rmsnorm')||/^(main|index|index-key)-norm$/.test(localId)){
    if(localId==='q-head-rmsnorm')return {name:'逐头 RMS 归一化',steps:[
      {label:'按每个查询头计算归一化系数',equation:'r = rsqrt(mean(q²) + 10⁻⁶)'},
      {label:'缩放该查询头的全部维度',equation:'y = q · r'},
    ]};
    const axis=localId==='q-rmsnorm'?'查询低秩维度':/^(kv|main|index)-/.test(localId)?'潜向量维度':'隐藏维度';
    return rmsNorm(axis,v41?'10⁻²⁰':'10⁻⁶');
  }
  if(localId.endsWith('-rope'))return {name:'部分 RoPE',steps:[
    {label:'在向量末尾的 R 个维度内做相邻配对',equation:'(a, b) = (x[D − R + 2j], x[D − R + 2j + 1])'},
    {label:localId==='output-rope'?'用位置角的共轭做逆旋转':'按对应位置角旋转',
      equation:localId==='output-rope'?'(a′, b′) = (ac + bs, bc − as)':'(a′, b′) = (ac − bs, as + bc)'},
  ]};
  if(localId.endsWith('-hc-sinkhorn'))return {name:'Hyper-Connections Sinkhorn',steps:[
    {label:'按通道计算分支输入与输出的门控',equation:'pre = σ(s₀m₀ + b₀) + ε,  post = 2σ(s₁m₁ + b₁)'},
    {label:'对残差混合矩阵按行做 softmax',equation:'A = softmax_row(s₂m₂ + b₂) + ε'},
    {label:'先做列归一化，再交替做行、列归一化',equation:'Aᵢⱼ ← Aᵢⱼ / (Σᵢ Aᵢⱼ + ε)'},
  ]};
  if(localId.endsWith('-hc-merge'))return {name:'Hyper-Connections 残差混合',steps:[
    {label:'用分支输出与原始残差流生成每条新残差流',equation:'yⱼ = postⱼ · branch + Σᵢ Aᵢⱼ · residualᵢ'},
  ]};
  if(localId.endsWith('-pool'))return {name:'门控分组压缩',steps:[
    {label:'沿分组 token 轴给每个特征计算权重',equation:'αₜ,ᵈ = softmaxₜ(gₜ,ᵈ + APEₜ,ᵈ)'},
    {label:'把分组内的值向量汇聚成一条缓存',equation:'zᵈ = Σₜ αₜ,ᵈ · vₜ,ᵈ'},
  ]};
  if(localId==='index-topk')return {name:'CSA 索引选择',steps:[
    {label:'汇总各头对候选压缩行的带权得分',equation:'sⱼ = Σₕ wₕ · ReLU(qₕ · kⱼ)'},
    {label:'在已完成且因果可见的压缩行中选择候选',equation:'indices = TopK(s, min(K, ⌊L / '+ratio+'⌋))'},
  ]};
  if(localId==='candidate-blocks')return {name:'CSA2 两级筛选',steps:[
    {label:'按块取最高位置分数，并保留最新可见块',equation:'block_score = max(position_scores)'},
    {label:'选出候选块并发布位置掩码供后续索引层复用',equation:'mask = expand(TopK(block_score, K_blocks))'},
  ]};
  if(localId==='engram-hash')return {name:'Engram n-gram 哈希',steps:[
    {label:'取规范化 token 与最多三个历史 token，序列边界用 pad 补齐',equation:'x₀, x₁, x₂, x₃'},
    {label:'对每层逐阶更新异或哈希，再以各表的质数和偏移计算行号',
      equation:'hₙ = ⊕ᵢ (xᵢ · mᵢ),  id = (hₙ mod pₙ) + offsetₙ'},
  ]};
  if(localId==='engram-gate'||localId==='engram-inject')return {name:'Engram 残差注入',steps:[
    {label:'每条残差流沿隐藏维计算归一化键查询内积',equation:'sⱼ = ⟨RMSNorm(xⱼ), RMSNorm(kⱼ)⟩ / √H'},
    {label:'应用带符号平方根和 sigmoid，将共享值写入该残差流',
      equation:'yⱼ = xⱼ + σ(sign(sⱼ) · √max(|sⱼ|, 10⁻⁶)) · v'},
  ]};
  return undefined;
}

function glm52Algorithm(localId:string):Algorithm|undefined {
  if(localId.endsWith('-rmsnorm'))return rmsNorm(localId==='q-rmsnorm'?'查询低秩维度':localId==='kv-rmsnorm'?'KV 潜向量维度':'隐藏维度','10⁻⁵');
  if(localId==='index-key-norm')return {name:'索引键 LayerNorm',steps:[
    {label:'沿每个索引键的 128 个特征求均值与方差',equation:'μ = mean(k),  σ² = mean((k − μ)²)'},
    {label:'应用仿射变换',equation:'y = γ ⊙ (k − μ) / √(σ² + 10⁻⁶) + β'},
  ]};
  if(localId.endsWith('-rope'))return {name:'交错部分 RoPE',steps:[
    {label:localId.startsWith('index-')?'在索引 Q 或 K 的前 64 维内配对':'在每个 Q 位置分量和共享 K 位置分量的 64 维内配对',equation:'(a, b) = (x[2j], x[2j+1])'},
    {label:'使用当前 token 的位置角，其他坐标保持原值',equation:'(a′, b′) = (ac − bs, as + bc)'},
  ]};
  if(localId==='index-topk'||localId==='index-reduce')return {name:'DSA 因果索引选择',steps:[
    {label:'按头计算索引内积，应用 ReLU 和学习得到的头权重',equation:'score(t) = Σₕ (wₕ / √32) · ReLU(⟨qₕ, kₜ⟩ / √128)'},
    {label:'屏蔽未来位置，选择行号供当前层和后续复用层读取',equation:'indices = TopK(score[t ≤ p], min(2048, p + 1))'},
  ]};
  if(['q-absorb','qk','av','v-up'].includes(localId))return {name:'吸收投影的稀疏 MLA',steps:[
    {label:'把非旋转键投影移到查询侧',equation:'q̃ₕ = Wₖ,ₕᵀ qₕ'},
    {label:'仅评分选中的位置，合并潜向量内积与位置内积',equation:'scoreₕ,ₜ = (⟨q̃ₕ, cₜ⟩ + ⟨qʳₕ, kʳₜ⟩) / √256'},
    {label:'沿选中行加权累计潜向量，随后上投影到值空间',equation:'oₕ = Wᵥ,ₕ · Σₜ softmax(scoreₕ)ₜ · cₜ'},
  ]};
  if(['route-topk','route-normalize','combine'].includes(localId))return {name:'GLM MoE 专家路由',steps:[
    {label:'用加修正偏置的 sigmoid 分数选出 8 个专家',equation:'s = σ(Wᵣx),  ids = TopK(s + b, 8)'},
    {label:'用原始分数归一化并加权汇总，再加共享专家分支',equation:'y = shared(x) + Σᵢ 2.5 · sᵢ / (Σⱼ sⱼ + 10⁻²⁰) · expertᵢ(x)'},
  ]};
}

function kimiK3Algorithm(localId:string):Algorithm|undefined {
  if(localId==='q-rmsnorm'||localId==='kv-rmsnorm')return rmsNorm(localId==='q-rmsnorm'?'查询低秩维度':'KV 潜向量维度','10⁻⁶');
  if(localId.endsWith('-rmsnorm'))return rmsNorm(localId==='latent-rmsnorm'?'专家潜向量维度':'隐藏维度','10⁻⁵');
  if(localId.endsWith('-depth-score')||localId.endsWith('-depth-mix'))return {name:'Attention Residuals',steps:[
    {label:'取同一 token 的历史块归档和当前块累加值',equation:'V = [v₁, …, vₚ, v_current]'},
    {label:'按隐藏维度归一化，以学习到的投影计算深度权重',equation:'sⱼ = wᵀ RMSNorm(vⱼ)'},
    {label:'沿块深度做 softmax，再加权汇总原始残差',equation:'y = Σⱼ softmax(s)ⱼ · vⱼ'},
  ]};
  if(localId==='bounded-decay'||localId==='recurrent')return {name:'Kimi Delta Attention',steps:[
    {label:'计算每个键通道带下界的对数衰减',equation:'g = −5 · σ(exp(A_log) · (F(x) + b))'},
    {label:'衰减旧状态，以归一化键读取当前预测并求修正',equation:'S̃ = diag(exp(g)) S,  δ = β · (v − kᵀS̃)'},
    {label:'写回 FP32 矩阵并由归一化查询读取',equation:'S′ = S̃ + kδᵀ,  y = qᵀS′'},
  ]};
  if(localId.endsWith('-situ'))return {name:'SiTU-GLU',steps:[
    {label:'限制门控和上投影两侧的值，并保留门控 sigmoid',equation:'a = 4 · tanh(gate / 4) · σ(gate),  u = 25 · tanh(up / 25)'},
    {label:'逐元素相乘后交给下投影',equation:'activation = a ⊙ u'},
  ]};
  if(['q-absorb','qk','av','mla-gate'].includes(localId))return {name:'Gated MLA · NoPE',steps:[
    {label:'吸收键上投影，额外 64 个通道直接参加内积',equation:'sₕ,ₜ = (⟨Wₖ,ₕᵀqₕ, cₜ⟩ + ⟨qˣₕ, kˣₜ⟩) / √192'},
    {label:'沿可见位置汇总潜向量，上投影后应用输出门',equation:'oₕ = σ(gₕ) ⊙ Wᵥ,ₕ Σₜ softmax(sₕ)ₜ cₜ'},
  ]};
  if(['latent-down','route-topk','combine','latent-up'].includes(localId))return {name:'Stable LatentMoE',steps:[
    {label:'从完整隐藏向量算路由分数，按修正偏置选 16 个专家',equation:'s = σ(Wᵣx),  ids = TopK(s + b, 16)'},
    {label:'将窄投影送入专家，用原始分数归一化后汇总',equation:'z = Σᵢ [sᵢ / (Σⱼ sⱼ + 10⁻²⁰)] · expertᵢ(W↓x)'},
    {label:'归一化并回到隐藏宽度，加上共享分支',equation:'y = W↑ RMSNorm(z) + shared(x)'},
  ]};
}

function sourceAlgorithm(asset: AssetDocument, localId: string) {
  const id = asset.assetId;
  const v41=id==='builtin:model:deepseek-v4.1-flash'||id.startsWith('builtin:module:deepseek-v41-block-');
  if(asset.revision<=2&&(v41||id==='builtin:model:deepseek-v4-flash'||id.startsWith('builtin:module:deepseek-v4-decoder-'))){
    const algorithm=deepSeekV4Algorithm(localId,v41,v41?(id.includes('-r2-')?'2':'1'):'4');
    const filename=localId.endsWith('-hc-sinkhorn')?'kernel.py':localId==='engram-hash'?'engram.py':'model.py';
    const source=asset.sources.find(item=>item.kind==='url'&&item.url.endsWith('/inference/'+filename));
    return algorithm&&source?.kind==='url'?{algorithms:[algorithm],url:source.url}:undefined;
  }
  if(asset.revision<=2&&(id==='builtin:model:glm-5.2'||id.startsWith('builtin:module:glm-5.2-block-'))){
    const algorithm=glm52Algorithm(localId);
    const filename=localId.endsWith('-rope')?'deepseek_v2.py':algorithm?.name==='吸收投影的稀疏 MLA'?'flashmla_sparse.py':'modeling_glm_moe_dsa.py';
    const source=asset.sources.find(item=>item.kind==='url'&&item.url.endsWith('/'+filename));
    return algorithm&&source?.kind==='url'?{algorithms:[algorithm],url:source.url}:undefined;
  }
  if(asset.revision<=3&&(id==='builtin:model:kimi-k3'||id.startsWith('builtin:module:kimi-k3-layer-'))){
    const algorithm=kimiK3Algorithm(localId);
    const filename=localId==='bounded-decay'?'gate.py':localId==='recurrent'?'fused_recurrent.py':'modeling_kimi_linear.py';
    const source=asset.sources.find(item=>item.kind==='url'&&item.url.endsWith('/'+filename));
    return algorithm&&source?.kind==='url'?{algorithms:[algorithm],url:source.url}:undefined;
  }
  const hybrid=asset.revision<=4&&/^builtin:(module:qwen-hybrid-(moe|dense)-(delta|gqa)|model:qwen3\.(5-397b-a17b|8-27b))$/.test(id);
  const family = hybrid?'qwen-hybrid':asset.revision <= 3 && /^builtin:(module:qwen3-decoder|model:qwen3-(0\.6b|1\.7b))$/.test(id) ? 'qwen'
    : asset.revision === 1 && /^builtin:(module:glm4-decoder|model:glm-4-9b)$/.test(id) ? 'glm'
    : asset.revision <= 3 && /^builtin:(module:deepseek-(v2-(expanded|absorbed)|v3-absorbed)-(dense|moe)|model:deepseek-(v2-lite-(expanded|absorbed)|v3|r1))$/.test(id) ? 'deepseek'
    : undefined;
  if (!family) return;
  const epsilon = family === 'glm' ? '1.5625 × 10⁻⁷' : '10⁻⁶';
  const filename = family === 'glm' ? 'modeling_chatglm.py' : family === 'qwen' ? 'modeling_qwen3.py'
    :family==='qwen-hybrid'?id.includes('-moe-')||id.includes('397b')?'modeling_qwen3_5_moe.py':'modeling_qwen3_5.py'
    :'modeling_deepseek.py';
  const source = asset.sources.find(item => item.kind === 'url' && item.url.endsWith('/' + filename));
  if (source?.kind !== 'url') return;
  const algorithms = ['input-norm', 'post-norm', 'final-norm'].includes(localId) ? [rmsNorm('隐藏维度', epsilon, hybrid)]
    : localId === 'kv-a-norm' && family === 'deepseek' ? [rmsNorm('KV 潜向量维度', epsilon)]
    : localId === 'q-a-norm' && family === 'deepseek' ? [rmsNorm('Q 潜向量维度', epsilon)]
    : localId === 'qk-norm-rope' && (family === 'qwen'||family==='qwen-hybrid') ? [rmsNorm('每个 Q/K head 的特征维度', epsilon, hybrid), rope(family)]
    : localId === 'rope' && family !== 'qwen' ? [rope(family)]
    : localId==='recurrent'&&hybrid?[recurrence]:[];
  if (algorithms.length) return { algorithms, url: source.url };
}

export function OperatorCalculation({ asset, nodeId }: { asset?: AssetDocument | undefined; nodeId: string }) {
  const localId = nodeId.split('/').at(-1);
  const content = asset && localId && sourceAlgorithm(asset, localId);
  if (!content) return null;
  return <details className="operator-calculation" open>
    <summary>算子计算步骤</summary>
    {content.algorithms.map(algorithm => <section key={algorithm.name} aria-label={algorithm.name + ' 计算步骤'}>
      <h3>{algorithm.name}</h3>
      <ol>{algorithm.steps.map(step => <li key={step.label}>{step.label}<code>{step.equation}</code></li>)}</ol>
    </section>)}
    <a href={content.url} target="_blank" rel="noreferrer">查看固定版本源码 ↗</a>
  </details>;
}
