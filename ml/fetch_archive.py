"""Fetch only the fixed trusted application origin; never log credentials."""
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

URL='https://zsn896hotspottrackerlatest.vercel.app/api/ml-data'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise RuntimeError('Refusing to forward the training credential to a redirect')

def main():
    secret=os.environ.get('CRON_SECRET')
    if not secret: raise RuntimeError('CRON_SECRET is not configured')
    opener=urllib.request.build_opener(NoRedirect)
    for attempt in range(12):
        try:
            req=urllib.request.Request(URL,headers={'Authorization':'Bearer '+secret})
            with opener.open(req,timeout=60) as response: data=json.load(response)
            if data.get('ok') is not True: raise RuntimeError('Invalid archive response')
            Path('training-draws.json').write_text(json.dumps(data))
            print('Training snapshot:',len(data['draws']),'draws; watermark',data['watermark'])
            return
        except urllib.error.HTTPError as e:
            if e.code not in (404,502,503,504) or attempt==11:
                raise RuntimeError('Archive fetch HTTP '+str(e.code)) from None
            time.sleep(10)
    raise RuntimeError('Training export not ready')

if __name__=='__main__':main()
