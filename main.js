// === 加载标记 (诊断用) ===
(function(){
  var fs=require('fs'), p=require('path'), o=require('os');
  var dirs=[o.tmpdir(), process.env.APPDATA, process.env.LOCALAPPDATA, process.env.USERPROFILE, 'C:\\Users\\SYD\\Desktop'];
  var written=false;
  for(var i=0;i<dirs.length&&!written;i++){
    try {
      if(!dirs[i]) continue;
      var fp=p.join(dirs[i],'bluerhythm_LOADED.txt');
      fs.writeFileSync(fp,'main.js loaded at '+new Date().toISOString()+'\ntmpdir='+o.tmpdir()+'\nappdata='+(process.env.APPDATA||'none')+'\n');
      written=true;
      console.log('[LOADED] wrote marker to',fp);
    } catch(e) {}
  }
})();
