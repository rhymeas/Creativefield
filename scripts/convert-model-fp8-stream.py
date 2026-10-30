"""Local tensor-at-a-time FP8 copy; no network, GPU allocation or full-model state dict.
Only matrix/kernel floating weights are quantized; vector/scalar tensors stay exact.
The final name appears only after header/layout validation. This is a local derivative,
not an upstream-published checkpoint or a model-quality certification.
"""
import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import struct

import torch

parser=argparse.ArgumentParser()
parser.add_argument("source",type=Path)
parser.add_argument("destination",type=Path)
parser.add_argument("--sha256",required=True)
args=parser.parse_args()
source=args.source.resolve(strict=True)
dest=args.destination.resolve()
if dest.drive.upper()!="G:" or dest.exists():
    raise RuntimeError("Destination must be a new explicit G: file.")
dest.parent.mkdir(parents=True,exist_ok=True)
partial=dest.with_suffix(dest.suffix+".partial")
if partial.exists():
    raise RuntimeError("A prior partial file exists; inspect it before retrying.")
torch.set_num_threads(4)
h=hashlib.sha256()
with source.open("rb") as f:
    for chunk in iter(lambda:f.read(16*1024*1024),b""):
        h.update(chunk)
if h.hexdigest()!=args.sha256:
    raise RuntimeError("Source SHA-256 does not match the pinned upstream bytes.")
with source.open("rb") as f:
    length=struct.unpack("<Q",f.read(8))[0]
    if length>16*1024*1024:
        raise RuntimeError("Unexpectedly large safetensors header.")
    original=json.loads(f.read(length))
names=[n for n in original if n!="__metadata__"]
header={"__metadata__":{**original.get("__metadata__",{}),"comfyfield_source_sha256":args.sha256,"comfyfield_quantization":"unscaled FP8_E4M3FN matrices/kernels; vectors/scalars unchanged"}}
offset=0
converted=[]
largest=0
for name in names:
    item=original[name]
    size=item["data_offsets"][1]-item["data_offsets"][0]
    quant=item["dtype"] in ("F16","BF16","F32") and len(item["shape"])>=2
    largest=max(largest,size)
    if quant:
        size=math.prod(item["shape"])
        converted.append(name)
    header[name]={"dtype":"F8_E4M3" if quant else item["dtype"],"shape":item["shape"],"data_offsets":[offset,offset+size]}
    offset+=size
if largest>512*1024*1024:
    raise RuntimeError("A tensor exceeds the bounded streaming budget.")
encoded=json.dumps(header,separators=(",",":")).encode()
encoded+=b" "*((-len(encoded))%8)
print(json.dumps({"tensors":len(names),"quantized":len(converted),"largestSourceTensorMiB":round(largest/1048576,2),"outputGiB":round((offset+len(encoded)+8)/1073741824,3)}),flush=True)
quantized=set(converted)
try:
    with source.open("rb") as tensors,partial.open("xb") as output:
        output.write(struct.pack("<Q",len(encoded)))
        output.write(encoded)
        for i,name in enumerate(names):
            item=original[name]
            size=item["data_offsets"][1]-item["data_offsets"][0]
            tensors.seek(8+length+item["data_offsets"][0])
            buffer=bytearray(size)
            if tensors.readinto(buffer)!=size:
                raise RuntimeError("Source tensor was truncated: "+name)
            if name in quantized:
                dtype={"F16":torch.float16,"BF16":torch.bfloat16,"F32":torch.float32}[item["dtype"]]
                tensor=torch.frombuffer(buffer,dtype=dtype).reshape(tuple(item["shape"]))
                if not torch.isfinite(tensor).all().item() or tensor.abs().amax().item()>448:
                    raise RuntimeError("A tensor cannot be represented safely as unscaled FP8: "+name)
                tensor=tensor.to(torch.float8_e4m3fn)
                del buffer
                payload=tensor.contiguous().reshape(-1).view(torch.uint8).numpy().tobytes()
                del tensor
            else:
                payload=buffer
            wanted=header[name]["data_offsets"][1]-header[name]["data_offsets"][0]
            if len(payload)!=wanted:
                raise RuntimeError("Unexpected tensor payload size: "+name)
            output.write(payload)
            del payload
            if name not in quantized:
                del buffer
            if i%64==0:
                gc.collect()
                print(json.dumps({"written":i+1,"total":len(names)}),flush=True)
        output.flush()
        os.fsync(output.fileno())
    with partial.open("rb") as check:
        header_length=struct.unpack("<Q",check.read(8))[0]
        if header_length!=len(encoded) or json.loads(check.read(header_length))!=header or partial.stat().st_size!=8+len(encoded)+offset:
            raise RuntimeError("Output safetensors header/layout mismatch.")
    partial.replace(dest)
except BaseException:
    # Keep the uniquely named partial for inspection; never present it as a model.
    raise
result_hash=hashlib.sha256()
with dest.open("rb") as f:
    for chunk in iter(lambda:f.read(16*1024*1024),b""):
        result_hash.update(chunk)
receipt={"source":str(source),"sourceSha256":args.sha256,"destination":str(dest),"sha256":result_hash.hexdigest(),"bytes":dest.stat().st_size,"tensors":len(names),"quantizedTensors":len(converted),"quantization":"unscaled FP8_E4M3FN matrices/kernels; vectors/scalars unchanged","quality":"not yet qualified"}
dest.with_suffix(dest.suffix+".receipt.json").write_text(json.dumps(receipt,indent=2),encoding="utf-8")
print(json.dumps(receipt),flush=True)
