from svglib.svglib import svg2rlg
from reportlab.graphics import renderPM

for name in ['logo_channel', 'logo_chat']:
    drawing = svg2rlg(f'media/{name}.svg')
    scale = 640 / drawing.width
    drawing.width = 640
    drawing.height = 640
    drawing.scale(scale, scale)
    renderPM.drawToFile(drawing, f'media/{name}.png', fmt='PNG', dpi=72)
    print(f'{name}.png created')
