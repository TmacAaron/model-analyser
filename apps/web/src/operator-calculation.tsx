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

function sourceAlgorithm(asset: AssetDocument, localId: string) {
  const id = asset.assetId;
  const hybrid=asset.revision===1&&/^builtin:(module:qwen-hybrid-(moe|dense)-(delta|gqa)|model:qwen3\.(5-397b-a17b|8-27b))$/.test(id);
  const family = hybrid?'qwen-hybrid':asset.revision <= 3 && /^builtin:(module:qwen3-decoder|model:qwen3-(0\.6b|1\.7b))$/.test(id) ? 'qwen'
    : asset.revision === 1 && /^builtin:(module:glm4-decoder|model:glm-4-9b)$/.test(id) ? 'glm'
    : asset.revision <= 2 && /^builtin:(module:deepseek-(v2-(expanded|absorbed)|v3-absorbed)-(dense|moe)|model:deepseek-(v2-lite-(expanded|absorbed)|v3|r1))$/.test(id) ? 'deepseek'
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
