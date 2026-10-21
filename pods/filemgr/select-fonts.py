"""Extract complete, explicitly supported families from Debian's extra font archive."""
from pathlib import Path
import shutil
import subprocess

families = {
    'newtx', 'newtxsf', 'newpx', 'libertinus', 'libertinus-fonts',
    'libertinus-type1', 'libertinus-otf', 'libertinust1math', 'libertine',
    'fontawesome', 'fontawesome5', 'xcharter', 'xcharter-math',
    'newcomputermodern', 'cm-unicode', 'stix', 'stix2-otf',
    'stix2-type1', 'kpfonts', 'kpfonts-otf', 'inconsolata',
}
archive = next(Path('/tmp').glob('texlive-fonts-extra_*.deb'))
subprocess.run(['dpkg-deb', '--extract', str(archive), '/tmp/font-archive'], check=True)
source = Path('/tmp/font-archive/usr/share/texlive/texmf-dist')
target = Path('/selected/usr/local/share/texmf')
count = 0
maps = set()
for path in source.rglob('*'):
    if not path.is_file():
        continue
    relative = path.relative_to(source)
    if not any(part.lower() in families for part in relative.parts[:-1]):
        continue
    dest = target / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
    count += 1
    if relative.parts[:2] == ('fonts', 'map') and path.suffix == '.map':
        maps.add(path.name)
if not count or not maps:
    raise RuntimeError('No selected fonts or font maps found')
config = target / 'web2c/updmap.cfg'
config.parent.mkdir(parents=True, exist_ok=True)
config.write_text(''.join(f'Map {name}\n' for name in sorted(maps)))
license_dir = Path('/selected/usr/share/doc/cattery-extra-fonts')
license_dir.mkdir(parents=True)
shutil.copy2('/tmp/font-archive/usr/share/doc/texlive-fonts-extra/copyright', license_dir / 'copyright')
(license_dir / 'families.txt').write_text('\n'.join(sorted(families)) + '\n')
print(f'Selected {count} files and {len(maps)} maps from {len(families)} families')
