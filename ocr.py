# python ~/bin/ocr.py -i /Volumes/Scans -o ~/Downloads/Scans -f jpg -d
from pathlib import Path
from argparse import ArgumentParser
import subprocess

# parse arguments - input folder, file extension, output folder, deskew
parser = ArgumentParser()
parser.add_argument("-i", "--input", dest="INPUT", help="input folder")
parser.add_argument("-o", "--output", dest="OUTPUT", help="output folder")
parser.add_argument("-f", "--file extension", dest="FILEEXTENSION", help="extension of input files to filter")
# deskew is a boolean flag
# if it is present, DESKEW is set to True, else it is set to False
parser.add_argument("-d", "--deskew", dest="DESKEW", help="deskew images", action="store_true")

args = parser.parse_args()

# display all arguments
print("INPUT : ", args.INPUT)
print("OUTPUT : ", args.OUTPUT)
print("FILEEXTENSION : ", args.FILEEXTENSION)
print("DESKEW : ", args.DESKEW)

p = Path(args.INPUT)
o = Path(args.OUTPUT)
files = p.glob('*')

for file in files:
    if file.suffix == '.'+args.FILEEXTENSION:
        print(file.name)
        if args.DESKEW:
            subprocess.run(["ocrmypdf", str(p/file.name), str(o/file.stem)+'.pdf', "--deskew", "--pdfa-image-compression", "jpeg", "--optimize", "3", "--sidecar", str(o/file.stem)+'.txt'])
        else:
            subprocess.run(["ocrmypdf", str(p/file.name), str(o/file.stem)+'.pdf', "--pdfa-image-compression", "jpeg", "--optimize", "3", "--sidecar", str(o/file.stem)+'.txt'])


# find . -name '*.jpg' | parallel -j 3  ocrmypdf '{}' '{}'.pdf --deskew --pdfa-image-compression jpeg --optimize 3 --sidecar '{}'.txt