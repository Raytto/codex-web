// Trace local entry points, retain whole upstream packages (including assets,
// licences, optional dependencies and nested versions). Never rewrite a library.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isBuiltin} from 'node:module';
import ts from 'typescript';
import {spawnSync} from 'node:child_process';
// Load the parser before pruning, then trace the actual production tree.
// Optional peers installed only for development must not enter a runtime manifest.
if(process.argv.includes('--prune')){
 const result=spawnSync('npm',['prune','--omit=dev'],{stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)throw new Error('Production dependency prune failed');
}
const root=process.cwd();
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const entries={
 host:['host-root-server','host-root-job','host-storage-worker',
  'codex-voice-review-worker','codex-conversation-title-worker','manage-user',
  ...fs.readdirSync('dist-server/server').filter(n=>n.endsWith('-cli.js')).map(n=>n.slice(0,-3))],
 observer:['storage-maintenance-cli'],
};
const linuxOptional=new Set(['node-pty']); // guarded Windows-only terminal; absent in Linux lock tree
function packageRoot(name,from,optional=false){
 for(let d=path.dirname(from);d.startsWith(root);d=path.dirname(d)){
  const p=path.join(d,'node_modules',name,'package.json');if(fs.existsSync(p))return path.dirname(p);
  if(d===root)break;
 }
 if(optional)return null;
 throw new Error(`Missing runtime dependency ${name} from ${path.relative(root,from)}`);
}
const topName=n=>n.startsWith('@')?n.split('/').slice(0,2).join('/'):n.split('/')[0];
function trace(profile){
 const local=new Set(),packages=new Set();
 function pkg(dir){
  if(!dir||packages.has(dir))return; packages.add(dir);
  const j=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
  for(const name of new Set([...Object.keys(j.dependencies??{}),...Object.keys(j.optionalDependencies??{}),...Object.keys(j.peerDependencies??{})])){
   const optional=name in (j.optionalDependencies??{})||j.peerDependenciesMeta?.[name]?.optional;
   pkg(packageRoot(name,path.join(dir,'package.json'),optional));
  }
 }
 function visit(file){
  if(local.has(file))return;
  if(!file.startsWith(path.join(root,'dist-server')+'/')||!fs.statSync(file).isFile())throw new Error('Invalid local module '+file);
  local.add(file);const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  function ref(s){
   if(isBuiltin(s))return;
   if(s.startsWith('.'))visit(path.resolve(path.dirname(file),s));
   else {const n=topName(s);pkg(packageRoot(n,file,linuxOptional.has(n)));}
  }
  function walk(n){
   if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier)ref(n.moduleSpecifier.text);
   if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||n.expression.getText(ast)==='require')){
    if(!ts.isStringLiteral(n.arguments[0]))throw new Error('Unresolved dynamic dependency in '+file);
    ref(n.arguments[0].text);
   }
   if(ts.isNewExpression(n)&&n.expression.getText(ast)==='URL'&&n.arguments?.length===2&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text.endsWith('.js'))ref(n.arguments[0].text);
   ts.forEachChild(n,walk);
  }walk(ast);
 }
 for(const n of entries[profile])visit(path.join(root,'dist-server/server',n+'.js'));
 const files={};
 function add(p){
  const st=fs.lstatSync(p); const rel=path.relative(root,p);
  if(st.isSymbolicLink()){
   if(!fs.realpathSync(p).startsWith(root+'/node_modules/'))throw new Error('Escaping package symlink '+p);
   files[rel]={link:fs.readlinkSync(p)};
  }else if(st.isDirectory())for(const n of fs.readdirSync(p).sort())add(path.join(p,n));
  else if(st.isFile())files[rel]={bytes:st.size,sha256:hash(p),mode:st.mode&0o777};
  else throw new Error('Special package file '+p);
 }
 // Keep the complete shared compiled tree for host/Web protocol hash parity.
 if(profile==='host')add(path.join(root,'dist-server'));else for(const p of local)add(p);
 for(const p of packages)add(p);
 for(const n of ['storage-access-monitor.py','storage-db-maintenance.py'])add(path.join(root,'deploy',n));
 const v={schema:'codex-web-process-package-v1',profile,entries:entries[profile].map(n=>'dist-server/server/'+n+'.js'),localModules:[...local].map(p=>path.relative(root,p)).sort(),packages:[...packages].map(p=>path.relative(root,p)).sort(),files};
 fs.mkdirSync('process-manifests',{recursive:true});fs.writeFileSync(`process-manifests/${profile}.json`,JSON.stringify(v,null,2)+'\n');
 console.log(JSON.stringify({profile,modules:local.size,packages:packages.size,bytes:Object.values(files).reduce((n,f)=>n+(f.bytes??0),0)}));
}
for(const p of Object.keys(entries))trace(p);
