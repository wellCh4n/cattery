"""Build-time checks for the file preview's common LaTeX dependencies."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

packages = """ctex.sty amsmath.sty amssymb.sty mathtools.sty unicode-math.sty
siunitx.sty physics.sty mhchem.sty tikz.sty pgfplots.sty circuitikz.sty
algorithm.sty algorithmicx.sty algpseudocode.sty algorithm2e.sty
biblatex.sty natbib.sty hyperref.sty cleveref.sty enumitem.sty tcolorbox.sty
minted.sty listings.sty booktabs.sty multirow.sty tabularx.sty longtable.sty
subcaption.sty float.sty beamer.cls fontawesome5.sty newtxtext.sty newtxmath.sty
libertinus.sty stix2.sty kpfonts.sty inconsolata.sty newpxtext.sty newpxmath.sty XCharter.sty binhex.tex pzdr.tfm""".split()
for package in packages:
    result = subprocess.run(["kpsewhich", package], capture_output=True, text=True)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError(f"Missing LaTeX dependency: {package}")
for tool in ["xelatex", "latexmk", "bibtex", "biber", "pygmentize", "fc-list"]:
    if not shutil.which(tool):
        raise RuntimeError(f"Missing tool: {tool}")
fonts = subprocess.check_output(["fc-list", ":", "family"], text=True)
for family in ["Noto Serif CJK", "Noto Sans CJK", "DejaVu Sans", "Liberation Serif", "Fira Code", "TeX Gyre Termes", "Libertinus Serif"]:
    if family not in fonts:
        raise RuntimeError(f"Missing font family: {family}")

science = r"""\documentclass[fontset=fandol]{ctexart}
\usepackage{amsmath,amssymb,mathtools,siunitx,physics}
\usepackage[version=4]{mhchem}
\usepackage{tikz,pgfplots,circuitikz}
\pgfplotsset{compat=1.18}
\usepackage{algorithm,algpseudocode,booktabs,tabularx,multirow}
\usepackage{listings,tcolorbox,subcaption,hyperref,cleveref,fontawesome5}
\begin{document}
\section{中文科学文档}\label{sec:test}
\href{https://example.com}{链接测试} \faIcon{check}
\[E=mc^2,\quad \int_0^1 x^2\,dx=\frac13\]
\SI{3.2}{\metre\per\second} \ce{2H2 + O2 -> 2H2O}
\begin{algorithm}\caption{Example}
\begin{algorithmic}\State $x\gets 1$\end{algorithmic}\end{algorithm}
\begin{tikzpicture}\begin{axis}[width=5cm]\addplot coordinates {(0,0) (1,1) (2,4)};\end{axis}\end{tikzpicture}
\begin{tabular}{lr}\toprule Item & Value\\\midrule Test & 42\\\bottomrule\end{tabular}
\begin{lstlisting}[language=Python]
print("hello")
\end{lstlisting}
\begin{tcolorbox}常用宏包和字体检查。\end{tcolorbox}
See \cref{sec:test}.
\end{document}
"""
documents = {
    "science": science,
    "newtx": r"\documentclass{article}\usepackage{newtxtext,newtxmath}\begin{document}NewTX $\sum_{i=1}^n i$.\end{document}",
    "stix": r"\documentclass{article}\usepackage{stix2}\begin{document}STIX $\sum_{i=1}^n i$.\end{document}",
    "kpfonts": r"\documentclass{article}\usepackage{kpfonts}\begin{document}KP $\int x\,dx$.\end{document}",
    "inconsolata": r"\documentclass{article}\usepackage{inconsolata}\begin{document}\texttt{monospace example}.\end{document}",
    "newpx": r"\documentclass{article}\usepackage{newpxtext,newpxmath}\begin{document}NewPX $\int x\,dx$.\end{document}",
    "xcharter": r"\documentclass{article}\usepackage{XCharter}\begin{document}Charter bold \textbf{example}.\end{document}",
    "libertinus": r"\documentclass{article}\usepackage{libertinus}\begin{document}Libertinus $\int x\,dx$.\end{document}",
    "unicode": r"\documentclass{article}\usepackage{unicode-math}\setmainfont{TeX Gyre Termes}\setmathfont{TeX Gyre Termes Math}\begin{document}Unicode $\int_0^1 x\,dx$.\end{document}",
    "slides": r"\documentclass{beamer}\begin{document}\begin{frame}{Preview}A slide with $E=mc^2$.\end{frame}\end{document}",
    "algorithm2e": r"\documentclass{article}\usepackage{algorithm2e}\begin{document}\begin{algorithm}\KwData{Input}$x\gets1$\;\caption{Test}\end{algorithm}\end{document}",
    "bibliography": r"\documentclass{article}\usepackage[backend=biber]{biblatex}\addbibresource{refs.bib}\begin{document}\cite{example}\printbibliography\end{document}",
}
with tempfile.TemporaryDirectory(prefix="latex-check-") as directory:
    work = Path(directory)
    (work / "refs.bib").write_text('@book{example,author={Ada Lovelace},title={Example},year={1843}}')
    env = os.environ.copy()
    env.update(openin_any="p", openout_any="p", TEXMFOUTPUT=directory)

    def run(args):
        result = subprocess.run(args, cwd=work, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError(f"Failed: {args}\n{result.stdout[-12000:]}")

    for name, source in documents.items():
        (work / f"{name}.tex").write_text(source)
        command = ["xelatex", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", f"{name}.tex"]
        run(command)
        if name == "bibliography":
            run(["biber", name])
        run(command)
        if not (work / f"{name}.pdf").read_bytes().startswith(b"%PDF-"):
            raise RuntimeError(f"Invalid PDF: {name}")
        print(f"PASS: {name}", flush=True)
print(f"PASS: {len(packages)} dependencies, tools, fonts, and {len(documents)} documents", flush=True)
