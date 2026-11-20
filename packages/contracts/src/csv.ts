export type CsvRow={line:number;cells:string[]};
export function parseCsv(text:string,options:{maxRows:number;maxColumns:number;maxCellLength?:number}):CsvRow[]{
  const rows:CsvRow[]=[],cells:string[]= [];let cell='',quoted=false,closed=false,line=1,start=1,recordTouched=false;
  const endCell=()=>{if(options.maxCellLength!==undefined&&cell.length>options.maxCellLength)throw Error(`CSV 第 ${line} 行：字段超过大小上限`);if(cells.length>=options.maxColumns)throw Error(`CSV 第 ${line} 行：列数超过 ${options.maxColumns}`);cells.push(cell);cell='';closed=false;},endRow=()=>{endCell();if(recordTouched||cells.some(c=>c!=='')){if(rows.length>=options.maxRows)throw Error(`CSV 行数超过 ${options.maxRows}`);rows.push({line:start,cells:[...cells]});}cells.length=0;recordTouched=false;};
  for(let i=0;i<text.length;i++){const c=text[i];if(c===undefined)continue;if(options.maxCellLength!==undefined&&cell.length>options.maxCellLength)throw Error(`CSV 第 ${line} 行：字段超过大小上限`);
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else{cell+=c;if(c==='\n')line++;else if(c==='\r'&&text[i+1]!=='\n')line++;}continue;}
    if(c===','){recordTouched=true;endCell();continue;}
    if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;endRow();line++;start=line;continue;}
    if(closed)throw Error(`CSV 第 ${line} 行：闭合引号后只能是分隔符或换行`);
    if(c==='"'){if(cell!=='')throw Error(`CSV 第 ${line} 行：引号必须位于字段开头`);quoted=true;recordTouched=true;}else{cell+=c;recordTouched=true;}
  }
  if(quoted)throw Error(`CSV 第 ${start} 行：引号未闭合`);if(recordTouched||cells.length||cell!=='')endRow();return rows;
}
