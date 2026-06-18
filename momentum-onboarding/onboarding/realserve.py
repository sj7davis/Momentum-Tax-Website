import subprocess, time, os, signal
env = dict(os.environ, DATABASE_URL="postgres://x", PORT="4400")
# stub pg so server boots without a real DB
stub = '''
const Module=require('module'); const o=Module._load;
Module._load=function(r){ if(r.endsWith('db/pool')) return {query:async()=>({rows:[]}),pool:{}}; return o.apply(this,arguments); };
require('./server.js');
'''
open("boot.js","w").write(stub)
proc = subprocess.Popen(["node","boot.js"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(2.5)

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1280,"height":900})
    pg.goto("http://127.0.0.1:4400/", wait_until="networkidle")
    pg.wait_for_timeout(2500)
    pg.screenshot(path="fixed-top.png")
    pg.screenshot(path="fixed-full.png", full_page=True)
    logo=pg.evaluate("()=>{const i=document.querySelector('.brand img');return{ok:i.naturalWidth>0,src:i.src};}")
    foot=pg.evaluate("()=>{const i=document.querySelector('.foot-brand img');return i?i.naturalWidth>0:null;}")
    font=pg.evaluate("()=>getComputedStyle(document.querySelector('h1')).fontFamily")
    # check a portal route still works
    r=pg.request.get("http://127.0.0.1:4400/portal/api/tiers"); 
    print("header logo loaded:", logo['ok'], "| src:", logo['src'])
    print("footer logo loaded:", foot)
    print("h1 font:", font)
    print("/portal/api/tiers status:", r.status)
    b.close()
proc.send_signal(signal.SIGTERM)
