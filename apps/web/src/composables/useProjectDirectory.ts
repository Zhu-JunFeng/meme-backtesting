import {inject,onScopeDispose,provide,type InjectionKey} from 'vue';
import {api} from '../api';
import {createProjectDirectory,type ProjectDirectory} from '../project-identity';
const key:InjectionKey<ProjectDirectory>=Symbol('page-project-directory');
export function provideProjectDirectory(){
 const directory=createProjectDirectory(async(projects,signal)=>(await api.post('/projects/lookup',{projects},{signal})).data.items);
 provide(key,directory);onScopeDispose(directory.dispose);return directory;
}
export function useProjectDirectory(){return inject(key)??provideProjectDirectory();}
