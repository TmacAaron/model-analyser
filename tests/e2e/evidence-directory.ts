/** Keep a composed rerun's observations separate from already signed checkpoints. */
export function evidenceDirectory(checkpoint:number){
 const value=process.env['MODEL_ANALYSER_EVIDENCE_CHECKPOINT']??String(checkpoint);
 if(!/^[1-9]\d{0,3}$/.test(value))throw Error('Invalid local evidence checkpoint');
 return '_local/evidence/checkpoint'+value;
}
