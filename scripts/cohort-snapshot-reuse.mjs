/** Reuse byte-verified local gzip files only when a fresh server snapshot has identical row hashes. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {link,mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGunzip} from 'node:zlib';
import {fileHash,hash,saveJson} from './cohort-snapshot.mjs';

const read=async path=>JSON.parse(await readFile(path,'utf8'));
export async function dataHash(path){
 const digest=createHash('sha256');
 for await(const chunk of createReadStream(path).pipe(createGunzip()))digest.update(chunk);
 return digest.digest('hex');
}
export async function reuseSnapshot(remoteManifestPath,remoteMetadataPath,existingDirectory,outputDirectory){
 const remote=await read(resolve(remoteManifestPath)),existing=await read(resolve(existingDirectory,'manifest.json'));
 const {checksum,...unsigned}=remote;
 assert.equal(hash(unsigned),checksum,'Remote manifest checksum mismatch');
 assert.equal(await fileHash(remoteMetadataPath),remote.metadataHash,'Remote metadata checksum mismatch');
 assert.equal(remote.files.length,existing.files.length,'Snapshot dimension count changed');
 const files=[];
 for(const row of remote.files){
  const prior=existing.files.find(x=>x.name===row.name);
  assert(prior,`Missing local dimension ${row.name}`);
  for(const field of ['chain','interval','type','rows','valid','dataHash'])assert.equal(prior[field],row[field],`${row.name} ${field} changed`);
  const oldPath=resolve(existingDirectory,row.name);
  assert.equal(await fileHash(oldPath),prior.sha256,`${row.name} local gzip checksum mismatch`);
  assert.equal(await dataHash(oldPath),row.dataHash,`${row.name} row content mismatch`);
  files.push({...row,sha256:prior.sha256});
 }
 const output=resolve(outputDirectory);await mkdir(output,{recursive:true});
 await link(resolve(remoteMetadataPath),resolve(output,'metadata.json'));
 for(const file of files)await link(resolve(existingDirectory,file.name),resolve(output,file.name));
 const manifest={...remote,files,sourceSnapshotChecksum:remote.checksum,reusedIdenticalRowsFrom:existing.checksum};
 delete manifest.checksum;manifest.checksum=hash(manifest);
 await saveJson(resolve(output,'manifest.json'),manifest);
 return manifest;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [remoteManifest,remoteMetadata,existing,output]=process.argv.slice(2);
 assert(remoteManifest&&remoteMetadata&&existing&&output,'REMOTE_MANIFEST REMOTE_METADATA EXISTING OUTPUT required');
 const manifest=await reuseSnapshot(remoteManifest,remoteMetadata,existing,output);
 console.log(JSON.stringify({sourceSnapshotChecksum:manifest.sourceSnapshotChecksum,localSnapshotChecksum:manifest.checksum,files:manifest.files.length}));
}
