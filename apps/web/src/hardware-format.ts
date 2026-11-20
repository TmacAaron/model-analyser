/** Keep nonzero values visible even when conversion to a large SI unit underflows. */
export function formatHardwareQuantity(value:number|string|undefined,scale:number,unit:string):string{
  if(typeof value!=='number')return '待填写';const n=value/scale;
  if(value!==0&&n===0)return value.toExponential(4)+' / '+scale.toExponential(4)+' '+unit;
  return (n!==0&&(Math.abs(n)<0.0001||Math.abs(n)>=1e12)?n.toExponential(4):new Intl.NumberFormat('en-US',{maximumFractionDigits:4}).format(n))+' '+unit;
}
