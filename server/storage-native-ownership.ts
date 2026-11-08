import type {DatabaseSync} from 'node:sqlite';
import {conversationThreadReferences,parentFrom,type LineageInventory} from './conversation-lineage.js';

/** A parent/child component belongs to one conversation only when all known
 * business references agree. This repairs missing parent/child mappings without
 * creating conversations or changing the original native thread identifiers. */
export function nativeOwnership(db:DatabaseSync,userId:string,executor:string,inventory:LineageInventory){
 const references=conversationThreadReferences(db,userId,executor),edges=new Map<string,Set<string>>(),parents=new Map<string,Set<string>>();
 const node=(id:string)=>{if(!edges.has(id))edges.set(id,new Set());};
 const edge=(child:string,parent:string|null)=>{node(child);if(!parent)return;node(parent);edges.get(child)!.add(parent);edges.get(parent)!.add(child);
  if(!parents.has(child))parents.set(child,new Set());parents.get(child)!.add(parent);};
 for(const row of inventory.rows)edge(String(row.id),parentFrom(row.source));
 for(const file of inventory.rollouts)edge(file.id,file.parentId);
 for(const row of inventory.edges)edge(String(row.child_thread_id),String(row.parent_thread_id));
 const visited=new Set<string>(),orphanRoots:string[]=[],conflicts:string[]=[];
 for(const id of [...edges.keys()].sort()){
  if(visited.has(id))continue;
  const component:string[]=[],queue=[id],owners=new Set<string>();
  while(queue.length){const next=queue.pop()!;if(visited.has(next))continue;visited.add(next);component.push(next);
   for(const owner of references.get(next)??[])owners.add(owner);queue.push(...edges.get(next)??[]);}
  if(owners.size===1){const owner=[...owners][0];for(const member of component)references.set(member,new Set([owner]));}
  else if(owners.size===0){const roots=component.filter(member=>!(parents.get(member)?.size));orphanRoots.push(...(roots.length?roots:[component.sort()[0]]));}
  else conflicts.push(...component);
 }
 return {references,orphanRoots,conflicts};
}
