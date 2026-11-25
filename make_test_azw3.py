#!/usr/bin/env python3
"""生成一个有效的 AZW3（KF8/MOBI7）测试文件，供阿波 JS 解析器实测。
格式严格按 PalmDB + MOBI 头 + PalmDOC 压缩（对照 KindleUnpack mobi_header / mobi_uncompress）。
用法：python3 make_test_azw3.py [输出路径]"""
import struct, sys

# ---------- PalmDOC 编码（与 JS 解码器互为镜像） ----------
def palmdoc_compress(data: bytes) -> bytes:
    out = bytearray()
    n = len(data)
    i = 0
    # 待发字面字节缓冲（用 count(1..8)+原字节 的形式发）
    lit = bytearray()
    def flush_lit():
        nonlocal lit
        while lit:
            chunk = bytes(lit[:8])
            out.append(len(chunk))
            out.extend(chunk)
            del lit[:8]
        lit = bytearray()
    while i < n:
        # 找最长回指（距离 1..2047，长度 3..10）
        best_len, best_dist = 0, 0
        max_dist = min(i, 2047)
        # 只在当前位置往回找
        for dist in range(1, max_dist + 1):
            l = 0
            while l < 10 and i + l < n and data[i + l] == data[i - dist + l]:
                l += 1
            if l >= 3 and l > best_len:
                best_len, best_dist = l, dist
                if l == 10:
                    break
        if best_len >= 3:
            flush_lit()
            v = (best_dist << 3) | (best_len - 3)
            out.append(0x80 | ((v >> 8) & 0x3F))
            out.append(v & 0xFF)
            i += best_len
            continue
        # 空格+ASCII 优化：0xC0|char 解成 " " + char
        if data[i] == 0x20 and i + 1 < n and data[i + 1] < 0x80:
            flush_lit()
            out.append(0xC0 | data[i + 1])
            i += 2
            continue
        lit.append(data[i])
        i += 1
        if len(lit) == 8:
            flush_lit()
    flush_lit()
    return bytes(out)

def build_azw3(html_bytes: bytes, title: str, out_path: str):
    # 正文按 4096 字节未压缩切块
    CHUNK = 4096
    chunks = [html_bytes[i:i+CHUNK] for i in range(0, len(html_bytes), CHUNK)] or [b'']
    text_records = len(chunks)
    comp_chunks = [palmdoc_compress(c) for c in chunks]

    title_b = title.encode('utf-8')
    # EXTH：只放 503（Updated_Title）
    exth_rec = struct.pack('>LL', 503, 8 + len(title_b)) + title_b
    exth_len = 12 + len(exth_rec)
    exth_len = ((exth_len + 3) >> 2) << 2
    exth = b'EXTH' + struct.pack('>LL', exth_len, 1) + exth_rec
    exth += b'\x00' * (exth_len - len(exth))

    # MOBI 头（232 字节，从 MOBI 起算；记录内偏移 = 16 + 下列偏移）
    mobi_len = 232
    mobi = bytearray(mobi_len)
    mobi[0:4] = b'MOBI'
    struct.pack_into('>L', mobi, 4, mobi_len)       # header_length
    struct.pack_into('>L', mobi, 8, 2)              # type
    struct.pack_into('>L', mobi, 12, 65001)         # codepage UTF-8
    struct.pack_into('>L', mobi, 16, 1)             # unique_id
    struct.pack_into('>L', mobi, 20, 6)             # version
    struct.pack_into('>L', mobi, 52, 1)             # first_nontext（占位，解析不依赖）
    title_off = mobi_len + len(exth)                 # 相对 MOBI 起始
    struct.pack_into('>L', mobi, 68, title_off)     # title_offset
    struct.pack_into('>L', mobi, 72, len(title_b))  # title_length
    struct.pack_into('>L', mobi, 104, 0)            # min_version 占位（0x68 处，traildata 条件用）
    struct.pack_into('>L', mobi, 108, 0xFFFFFFFF)   # first_resc_offset：无图
    struct.pack_into('>L', mobi, 112, 0x40)         # exth_flags：有 EXTH
    struct.pack_into('>L', mobi, 152, 0xFFFFFFFF)   # drm_offset：无 DRM
    struct.pack_into('>L', mobi, 156, 0)            # drm_count
    struct.pack_into('>L', mobi, 160, 0)            # drm_size
    struct.pack_into('>L', mobi, 164, 0)            # drm_flags
    struct.pack_into('>H', mobi, 192, 1)            # first_content
    struct.pack_into('>H', mobi, 194, text_records) # last_content
    struct.pack_into('>H', mobi, 226, 0)            # traildata_flags：无尾部数据
    # 注意：traildata 条件要求 header_length>=0xE4(228) 且 0x68 处版本>=5；
    # 这里 0x68 处写 0，条件不成立，解析器不裁剪——与生成文件一致。

    # PalmDOC 头（16 字节）：compression@0(H) fill@2(H) text_length@4(L) text_records@8(H) max_section@10(H) crypto@12(H) fill@14(H)
    palmdoc = struct.pack('>HHLHHHH', 2, 0, len(html_bytes), text_records, 4096, 0, 0)
    rec0 = palmdoc + bytes(mobi) + exth + title_b

    records = [rec0] + comp_chunks
    num_records = len(records)
    # PalmDB 头 78 字节 + 记录表
    header_size = 78 + num_records * 8
    offsets = []
    pos = header_size
    for r in records:
        offsets.append(pos)
        pos += len(r)
    pdb = bytearray()
    name = title.encode('utf-8')[:31]
    pdb.extend(name + b'\x00' * (32 - len(name)))
    pdb.extend(struct.pack('>HH', 0, 0))            # attributes, version
    pdb.extend(struct.pack('>LLLL', 0, 0, 0, 0))    # dates, modnum
    pdb.extend(struct.pack('>LL', 0, 0))            # appInfo, sortInfo
    pdb.extend(b'BOOKMOBI')                         # type, creator
    pdb.extend(struct.pack('>LL', 0, 0))            # uniqueIDSeed, nextRecordList
    pdb.extend(struct.pack('>H', num_records))
    for off in offsets:
        pdb.extend(struct.pack('>L', off))
        pdb.extend(b'\x00\x00\x00\x00')             # attr + uniqueID（4 字节占位：1+3）
    # 注意：记录表每项是 8 字节（4 偏移 + 1 属性 + 3 ID）；上面多写了 1 字节，做修正：
    # 重新算：上面循环每次写了 4+4=8 字节，正好 8 字节/项，正确（属性+ID 合并写 4 字节零）。
    assert len(pdb) == header_size, (len(pdb), header_size)
    with open(out_path, 'wb') as f:
        f.write(bytes(pdb))
        for r in records:
            f.write(r)
    return out_path, len(html_bytes), text_records

HTML = """<html><head><title>活着测试</title></head><body>
<h1>前言</h1>
<p>一位真正的作家永远只为内心写作，只有内心才会真实地告诉他，他的自私、他的高尚是多么突出。</p>
<p>内心让他真实地了解自己，一旦了解了自己也就了解了世界。</p>
<h1>第一章</h1>
<p>很多年前我就明白了这个原则，可是要捍卫这个原则必须付出艰辛的劳动和长时期的痛苦，因为内心并非时时刻刻都是敞开的，它更多的时候倒是封闭的。</p>
<p>福贵是村里有名的败家子，年轻时把家产输得一干二净，只剩下一头老牛和一间茅屋。</p>
<p>他从地主少爷变成了佃农，命运的绳索越勒越紧，可他还是咬着牙活了下来。</p>
<h1>第二章</h1>
<p>家珍是福贵的老婆，她跟着他吃了半辈子的苦，却从来没有抱怨过一句。</p>
<p>凤霞是他们的女儿，生下来就聋哑，可她笑起来的时候，整个院子都亮了。</p>
<p>有庆是他们的儿子，跑得飞快，村里人都说这孩子将来有出息。</p>
<h1>第三章</h1>
<p>日子一天天过去，福贵学会了跟命运讲和，不再跟它较劲。</p>
<p>他赶着老牛走在田埂上，哼着不成调的小曲，觉得这样活着也挺好。</p>
<p>活着本身，就是最大的意义。</p>
</body></html>"""

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/test-huozhe.azw3'
    path, raw_len, nrec = build_azw3(HTML.encode('utf-8'), '活着测试', out)
    print(f'wrote {path} raw={raw_len} text_records={nrec}')
    # 自检：用 mobi 库的 PalmDOC 解码器验证能解回原文
    import sys as _s
    _s.path.insert(0, '/usr/local/lib/python3.12/dist-packages')
    from mobi.mobi_uncompress import PalmdocReader
    with open(path, 'rb') as f:
        data = f.read()
    import struct as _st
    nrecs = _st.unpack_from('>H', data, 76)[0]
    offs = [_st.unpack_from('>L', data, 78 + i * 8)[0] for i in range(nrecs)] + [len(data)]
    rec0 = data[offs[0]:offs[1]]
    assert rec0[16:20] == b'MOBI', 'MOBI magic missing'
    comp = _st.unpack_from('>H', rec0, 0)[0]
    trecs = _st.unpack_from('>H', rec0, 8)[0]
    print(f'self-check: compression={comp} text_records={trecs} numRecords={nrecs}')
    dec = PalmdocReader()
    out_b = b''.join(dec.unpack(data[offs[i]:offs[i+1]]) for i in range(1, trecs + 1))
    assert out_b == HTML.encode('utf-8'), 'round-trip mismatch!'
    print('self-check: PalmDOC round-trip OK, decoded bytes =', len(out_b))
