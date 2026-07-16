(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const state = { viewer:null, pointcloud:null, config:null, boundary:null, contours:null, crop:null, overlay:null, three:null };

  async function ensureServiceWorker(){
    if(!('serviceWorker' in navigator) || (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1')) return;
    await navigator.serviceWorker.register('./sw-octree.js',{scope:'./'});
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller){
      await new Promise(resolve => {
        const timer=setTimeout(resolve,1500);
        navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve()},{once:true});
      });
    }
  }

  function setStatus(message){ $('#statusText').textContent=message; }
  function hideLoader(){ $('#loader').classList.add('is-hidden'); }

  function applyCamera(){
    const {target,distance,altitude,azimuth_rad:azimuth}=state.config.camera;
    const view=state.viewer.scene.view;
    view.position.set(target[0]+distance*Math.cos(azimuth),target[1]+distance*Math.sin(azimuth),target[2]+altitude);
    view.lookAt(target[0],target[1],target[2]);
  }

  function addCrop(){
    const [west,south,east,north]=state.config.crop.bounds_xy;
    const [zMin,zMax]=state.config.crop.z_range;
    const volume=new Potree.BoxVolume();
    volume.name='encuadre-publico';
    volume.position.set((west+east)/2,(south+north)/2,(zMin+zMax)/2);
    volume.scale.set(east-west,north-south,zMax-zMin);
    volume.clip=true;volume.visible=false;volume.userData.publicCrop=true;
    volume.updateMatrixWorld(true);
    state.viewer.scene.addVolume(volume);
    state.viewer.setClipTask(Potree.ClipTask.SHOW_INSIDE);
    state.viewer.setClipMethod(Potree.ClipMethod.INSIDE_ANY);
    state.crop=volume;
  }

  function harvestThree(){
    const Vector3=state.viewer.scene.view.position.constructor;
    const box=new Potree.Box3Helper(state.pointcloud.boundingBox);
    const GeomCls=box.geometry.constructor;
    const BufferAttrCls=box.geometry.attributes.position.constructor;
    const LineMatCls=box.material.constructor;
    const LineCls=Object.getPrototypeOf(box.constructor.prototype).constructor;
    const volume=new Potree.BoxVolume();
    const mesh=volume.box||volume.children.find(item=>/Mesh/.test(item.type||''));
    if(!mesh)throw new Error('No fue posible preparar las capas vectoriales');
    return {Vector3,GeomCls,BufferAttrCls,LineMatCls,LineCls,MeshCls:mesh.constructor,MeshMatCls:mesh.material.constructor};
  }

  async function addBoundary(){
    const data=await fetch('assets/data/predio-3d.json',{cache:'force-cache'}).then(r=>{if(!r.ok)throw new Error(r.status);return r.json()});
    const T=state.three,pos=[],idx=[],half=.24;
    for(let i=1;i<data.ring_xyz.length;i+=1){
      const a=data.ring_xyz[i-1],b=data.ring_xyz[i],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy)||1,nx=-dy/length*half,ny=dx/length*half,base=pos.length/3;
      pos.push(a[0]+nx,a[1]+ny,a[2]+.5,a[0]-nx,a[1]-ny,a[2]+.5,b[0]+nx,b[1]+ny,b[2]+.5,b[0]-nx,b[1]-ny,b[2]+.5);
      idx.push(base,base+1,base+2,base+1,base+3,base+2);
    }
    const geometry=new T.GeomCls();geometry.setAttribute('position',new T.BufferAttrCls(new Float32Array(pos),3));geometry.setIndex(idx);
    const material=new T.MeshMatCls({color:0xff594d,transparent:true,opacity:.98,depthTest:false,depthWrite:false,side:2});
    const ribbon=new T.MeshCls(geometry,material);ribbon.name='area-de-analisis';ribbon.renderOrder=900;
    state.overlay.add(ribbon);state.boundary=ribbon;
  }

  async function addContours(){
    const data=await fetch('assets/data/contours-3d.json',{cache:'force-cache'}).then(r=>{if(!r.ok)throw new Error(r.status);return r.json()});
    const T=state.three,vertices=[];
    for(const line of data.polylines){
      if(line.coordinates.length<2)continue;
      for(let i=1;i<line.coordinates.length;i+=1){const a=line.coordinates[i-1],b=line.coordinates[i];vertices.push(new T.Vector3(a[0],a[1],a[2]+.24),new T.Vector3(b[0],b[1],b[2]+.24))}
    }
    const geometry=new T.GeomCls().setFromPoints(vertices);
    const material=new T.LineMatCls({color:0x5aade0,transparent:true,opacity:.92,depthTest:false,depthWrite:false});
    const segments=new T.LineCls(geometry,material);segments.name='curvas-relativas';segments.renderOrder=700;
    state.overlay.add(segments);state.contours=segments;
  }

  function setupTools(){
    const viewer=state.viewer;
    const presets={
      distance:{showDistances:true,closed:false,name:'Distancia'},
      area:{showDistances:true,showArea:true,closed:true,name:'Área'},
      height:{showDistances:false,showHeight:true,closed:false,maxMarkers:2,name:'Altura'}
    };
    $$('.tools button[data-tool]').forEach(button=>button.addEventListener('click',()=>{
      const tool=button.dataset.tool;
      $$('.tools button').forEach(item=>item.classList.remove('is-active'));
      if(tool==='clear'){
        viewer.scene.removeAllMeasurements();viewer.scene.removeAllProfiles();viewer.scene.removeAllVolumes();setStatus('Mediciones eliminadas');return;
      }
      button.classList.add('is-active');setStatus(`Herramienta: ${button.querySelector('em').textContent}`);
      if(presets[tool])viewer.measuringTool.startInsertion(presets[tool]);
      if(tool==='profile')viewer.profileTool.startInsertion({name:'Perfil del terreno'});
      if(tool==='volume')viewer.volumeTool.startInsertion({name:'Volumen',clip:false});
    }));
  }

  function setupColorModes(){
    $$('.mode-switch button').forEach(button=>button.addEventListener('click',()=>{
      if(!state.pointcloud)return;
      const mode=button.dataset.color;
      state.pointcloud.material.activeAttributeName=mode;
      $$('.mode-switch button').forEach(item=>item.classList.toggle('is-active',item===button));
      $('#elevationLegend').hidden=mode!=='elevation';
      setStatus(mode==='rgba'?'Color real':mode==='elevation'?'Relieve por altura relativa':'Clasificación de superficie');
    }));
  }

  function setupLayers(){
    const trigger=$('#layersTrigger'),panel=$('#layersPanel');
    trigger.addEventListener('click',()=>{const open=panel.hidden;panel.hidden=!open;trigger.setAttribute('aria-expanded',String(open))});
    $$('.layer-toggle').forEach(button=>button.addEventListener('click',()=>{
      const key=button.dataset.layer;const visible=!button.classList.contains('is-active');button.classList.toggle('is-active',visible);
      if(key==='boundary'&&state.boundary)state.boundary.visible=visible;
      if(key==='contours'&&state.contours)state.contours.visible=visible;
      if(key==='crop'&&state.crop){state.crop.clip=visible;state.viewer.setClipTask(visible?Potree.ClipTask.SHOW_INSIDE:Potree.ClipTask.NONE)}
    }));
    $('#density').addEventListener('input',event=>{const value=Number(event.target.value);state.viewer.setPointBudget(value);$('#densityValue').value=`${(value/1e6).toFixed(value%1e6?1:0)} M`});
    $('#focusArea').addEventListener('click',()=>{applyCamera();panel.hidden=true;trigger.setAttribute('aria-expanded','false');setStatus('Encuadre restaurado')});
    $('#dismissHint').addEventListener('click',()=>$('#hint').remove());
  }

  async function init(){
    try{
      $('#loaderText').textContent='Protegiendo referencias y preparando el modelo…';
      await ensureServiceWorker();
      const [config]=await Promise.all([
        fetch('assets/data/viewer.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error(r.status);return r.json()})
      ]);
      state.config=config;
      $('#pointCount').textContent=`${(config.point_count/1e6).toFixed(1)} M puntos`;
      $('#elevationMin').textContent=`${config.elevation_display_range[0].toFixed(1)} m`;
      $('#elevationMax').textContent=`${config.elevation_display_range[1].toFixed(1)} m`;

      Potree.scriptPath=new URL('/assets/potree/build/potree',location.origin).href.replace(/\/$/,'');
      Potree.resourcePath=new URL('/assets/potree/build/potree/resources',location.origin).href.replace(/\/$/,'');
      const viewer=new Potree.Viewer($('#potree_render_area'));state.viewer=viewer;window.__publicPotree=state;
      viewer.setEDLEnabled(true);viewer.setEDLRadius(1.4);viewer.setEDLStrength(.45);viewer.setFOV(60);viewer.setPointBudget(4000000);viewer.setBackground('black');
      viewer.setControls(matchMedia('(pointer:coarse)').matches?viewer.orbitControls:viewer.earthControls);
      state.overlay=new viewer.scene.scene.constructor();
      state.overlay.name='capas-publicas-overlay';
      viewer.addEventListener('render.pass.perspective_overlay',()=>viewer.renderer.render(state.overlay,viewer.scene.getActiveCamera()));
      addCrop();setupTools();setupColorModes();setupLayers();

      Potree.loadPointCloud('assets/cloud/metadata.json','terrain-case',event=>{
        const cloud=event.pointcloud;state.pointcloud=cloud;
        const material=cloud.material;material.pointSizeType=Potree.PointSizeType.ADAPTIVE;material.shape=Potree.PointShape.CIRCLE;material.size=1.45;material.activeAttributeName='rgba';material.elevationRange=config.elevation_display_range.slice();material.gradient=Potree.Gradients.TURBO;material.rgbGamma=.82;material.rgbBrightness=.1;
        viewer.scene.addPointCloud(cloud);state.three=harvestThree();applyCamera();setTimeout(applyCamera,80);
        Promise.all([addBoundary(),addContours()]).then(()=>setStatus('Modelo interactivo listo')).catch(error=>{console.error('Capas técnicas:',error);setStatus('Modelo listo · capas no disponibles')});
        let attempts=0;const ready=setInterval(()=>{attempts+=1;const visible=(cloud.visibleNodes||[]).reduce((sum,node)=>sum+(node.getNumPoints?node.getNumPoints():(node.numPoints||0)),0);if(visible>500000||attempts>30){clearInterval(ready);hideLoader()}},300);
      });
    }catch(error){console.error(error);$('#loaderText').textContent='No fue posible iniciar el visor. Actualiza la página o inténtalo en otra conexión.';setStatus('Visor no disponible')}
  }

  window.addEventListener('load',init,{once:true});
})();
