#!/usr/bin/env python3
"""Read a SER file once, block-reduce every frame by --bin, save float16 stack
to a .npy in the scratchpad so the detector can iterate without re-reading GBs."""
import struct, os, sys, time
import numpy as np
HEADER = 178
def read_header(path):
    with open(path, "rb") as fh: h = fh.read(HEADER)
    luid, colorid, little, w, ht, depth, fc = struct.unpack("<7i", h[14:14+28])
    bpp = 1 if depth <= 8 else 2
    planes = 3 if colorid >= 100 else 1
    return dict(w=w, h=ht, frames=fc, framebytes=w*ht*bpp*planes, planes=planes,
                dtype=np.uint8 if bpp==1 else ("<u2" if little else ">u2"))
def main(path, b, outnpy, stride):
    hdr = read_header(path)
    idxs = list(range(0, hdr["frames"], stride))
    H=(hdr["h"]//b)*b; W=(hdr["w"]//b)*b
    out = np.empty((len(idxs), H//b, W//b), np.float16)
    t0=time.time()
    with open(path,"rb") as fh:
        for k,i in enumerate(idxs):
            fh.seek(HEADER+i*hdr["framebytes"])
            raw=np.frombuffer(fh.read(hdr["framebytes"]),dtype=hdr["dtype"])
            img=raw.reshape(hdr["h"],hdr["w"]).astype(np.float32)[:H,:W]
            out[k]=img.reshape(H//b,b,W//b,b).mean(axis=(1,3)).astype(np.float16)
            if k%50==0: print(f"  {k}/{len(idxs)}  {time.time()-t0:.0f}s",flush=True)
    np.save(outnpy, out)
    np.save(outnpy+".idx.npy", np.array(idxs))
    print(f"saved {out.shape} -> {outnpy}  ({os.path.getsize(outnpy)/1e6:.0f} MB, {time.time()-t0:.0f}s)")
if __name__=="__main__":
    path=sys.argv[1]; b=int(sys.argv[2]); outnpy=sys.argv[3]
    stride=int(sys.argv[4]) if len(sys.argv)>4 else 1
    main(path,b,outnpy,stride)
