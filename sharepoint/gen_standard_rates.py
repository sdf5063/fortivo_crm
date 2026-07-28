#!/usr/bin/env python3
"""Emit the STANDARD_RATE_CARD JS constant from the canonical Fortivo rate data.

Source of truth: 03_Rate Sheets/T&M HTML/rates.json, version 2026-V1.5
(effective June 2026), read from SharePoint on 2026-07-28. When rates change,
re-read rates.json, update the tables below, and re-run patch_crm.py.
"""
import io, json, sys

VERSION = '2026-V1.5'
EFFECTIVE = 'June 2026'

LABOR = [  # name, hourly
    ('Asbestos Supervisor', 90), ('Asbestos Technician', 68.75),
    ('Assistant Project Manager', 76.5), ('Carpenter / Framer', 95),
    ('Drywall / Painter', 80.5), ('Equipment Operator / Technician', 107.5),
    ('Estimator', 115), ('General Laborer', 45.5),
    ('Mold / Lead Remediation Supervisor', 80), ('Mold / Lead Remediation Technician', 65.75),
    ('Project Manager', 120), ('Restoration Technician', 54.5),
    ('Senior PM / Ops Manager', 139), ('Skilled Tradesman', 73.75),
]

EQUIPMENT = [  # name, daily, weekly, monthly  (0 = not offered at that term)
    ('360 Camera', 189, 0, 0), ('Air Mover', 31, 150, 435),
    ('Axial Air Mover', 44, 220, 675), ('Dehu LGR <120 pints/Day', 100, 500, 1165),
    ('Dehu LGR >120 pints/Day', 165, 800, 2000), ('Desiccant - Up to 800 CFM', 950, 6000, 23000),
    ("Extension Cord 100'", 65, 185, 375), ("Extension Cord 50'", 40, 145, 325),
    ('Floor/Tile Machine Clean', 445, 2225, 6995), ('GFCI Triple Tap', 26.4, 105, 265),
    ('HEPA Neg Air <750 CFM', 90, 460, 1350), ('HEPA Neg Air >750 CFM', 150, 750, 1925),
    ('HEPA Neg Air XL 2000 CFM', 200, 900, 2700), ('Hydroxyl Generator', 215, 950, 3000),
    ('Manometer Recorder', 112, 560, 1695), ('Moisture Meter', 27.5, 0, 0),
    ('Ozone Generator', 155, 745, 2115), ('Particle Counter', 112.45, 562.25, 1690),
    ('Portable Extraction Unit', 200, 0, 0), ("Power Cable 3/2 Banded 50'", 40, 200, 655),
    ('Thermal Imaging Camera', 205, 0, 0), ('Vacuum - HEPA Industrial', 90, 455, 1200),
    ('Vacuum - Shop Vacuum', 40, 200, 655), ('Wall/Floor Drying System', 150, 750, 2250),
    ('Vehicle', 150, 0, 0), ('Portable AC/Heat < 15,000 BTU', 100, 400, 1300),
    ('Portable AC/Heat > 15,000 BTU', 125, 500, 1850), ('Containment Poles, Each', 7, 25, 80),
]

CONSUMABLES = [  # name, rate, unit
    ('Adhesive Remover', 16.45, 'each'), ('All Purpose Cleaner', 43.75, 'gal'),
    ('Deodorizer Solution', 44.5, 'gal'), ('Disinfectant / Anti-microbial', 57.5, 'gal'),
    ('Dry Clean Sponges', 2.33, 'each'), ('Mask, Dust', 44.75, 'box'),
    ('Extra Duty Cleaner/Degreaser', 45, 'gal'), ('Filter, Charcoal', 43, 'each'),
    ('Filter, HEPA - Air Scrubber', 306.95, 'each'), ('Filter, HEPA - Shop Vac', 52.5, 'each'),
    ('Filter, Pleated - Air Scrubber', 40.45, 'each'), ('Filter, Pleated - Dehumidifier', 12, 'each'),
    ('Glass Cleaner', 15.6, 'gal'), ('Gloves - Latex', 22.35, 'box'),
    ('Gloves - Nitrile', 32.2, 'box'), ('Mop Heads - Microfiber', 36.45, 'each'),
    ('Mop Heads - Regular Cotton', 8.15, 'each'), ('Odor Counteractant, Blocks', 8.8, 'each'),
    ('Plastic Sheeting-Carpet Prot.', 36.5, 'roll'), ('Poly Lay Flat - 4mil', 92.5, 'roll'),
    ('Poly Sheeting - 100x2mil', 40, 'roll'), ('Poly Sheeting - 100x4mil', 60, 'roll'),
    ('Poly Sheeting - 100x6mil', 100, 'roll'), ('Poly Sheeting-Fire 100x4mil', 175, 'roll'),
    ('Ram Board (38" x 100\')', 146.5, 'roll'), ('Shoe Covers', 37.85, 'box'),
    ('Sponge - Soot/Chem', 4, 'each'), ('Spray Adhesives', 27.95, 'each'),
    ('Tape - Duct', 7.5, 'each'), ('Tape - Containment', 11.15, 'each'),
    ('Tape - Painters', 5.25, 'each'), ('Trash Bags - 3mil', 29.1, 'roll'),
    ('Trash Bags - 6mil Heavy Duty', 96.55, 'roll'), ('Tyvek Suits', 12.45, 'each'),
    ('Wall Zippers (2 pack)', 38.25, 'pack'), ('Workshop Rags (20 count)', 25, 'pack'),
    ('Filter, HEPA - Hepa Vac', 220, 'each'), ('Poly Lay Flat - 4mil Flame Retardant', 105, 'each'),
    ('Mask, N-95', 62.75, 'box'), ('Mask, 1/2 Face Respirator', 21.2, 'each'),
    ('Respirator Filter, Particulate', 13.1, 'each'), ('Respirator Filter, Vapor', 26.2, 'each'),
]

# Admin charges clients most often negotiate. Multipliers and minimums are not
# dollar rates, so they are not rate-card lines.
ADMIN = [
    ('Project Documentation Fee', 150, 'flat'), ('Debris Disposal', 150, 'flat'),
    ('Emergency Surcharge', 250, 'flat'), ('Small Tools', 3, '%'),
    ('Mileage', 2.25, 'each'), ('Per Diem', 65, 'each'),
]


def rows():
    out = []
    for name, hourly in LABOR:
        out.append({'label': name, 'unit': 'hour', 'rate': hourly, 'cat': 'Labor'})
    for name, d, w, m in EQUIPMENT:
        out.append({'label': name, 'unit': 'day', 'rate': d, 'cat': 'Equipment'})
        if w: out.append({'label': name, 'unit': 'week', 'rate': w, 'cat': 'Equipment'})
        if m: out.append({'label': name, 'unit': 'month', 'rate': m, 'cat': 'Equipment'})
    for name, rate, unit in CONSUMABLES:
        out.append({'label': name, 'unit': unit, 'rate': rate, 'cat': 'Consumable'})
    for name, rate, unit in ADMIN:
        out.append({'label': name, 'unit': unit, 'rate': rate, 'cat': 'Admin'})
    return out


def emit_js():
    rs = rows()
    lines = []
    for r in rs:
        lines.append('  {label:%s,unit:%s,rate:%s,cat:%s}' % (
            json.dumps(r['label']), json.dumps(r['unit']),
            repr(r['rate']).rstrip('.0') if isinstance(r['rate'], float) and r['rate'] == int(r['rate']) else repr(r['rate']),
            json.dumps(r['cat'])))
    return (
        "// Canonical Fortivo published rates — version %s, effective %s.\n"
        "// Mirrored from 03_Rate Sheets/T&M HTML/rates.json, the single source of truth\n"
        "// the T&M trackers and client rate sheets are generated from. %d lines.\n"
        "// To refresh: re-read rates.json, update sharepoint/gen_standard_rates.py, re-run patch_crm.py.\n"
        "const STANDARD_RATE_VERSION = %s;\n"
        "const STANDARD_RATE_EFFECTIVE = %s;\n"
        "const STANDARD_RATE_CARD = [\n%s\n];\n"
    ) % (VERSION, EFFECTIVE, len(rs), json.dumps(VERSION), json.dumps(EFFECTIVE), ',\n'.join(lines))


if __name__ == '__main__':
    js = emit_js()
    if len(sys.argv) > 1:
        io.open(sys.argv[1], 'w', encoding='utf-8').write(js)
        print('wrote %s (%d rate lines)' % (sys.argv[1], len(rows())))
    else:
        sys.stdout.write(js)
