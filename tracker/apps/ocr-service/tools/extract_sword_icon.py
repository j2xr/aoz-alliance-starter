import os
import sys

import cv2

# 1. Add the path to the 'app' folder so Python finds preprocess.py
# Go up one level from 'tools' to reach the 'ocr-service' root then 'app'
current_dir = os.path.dirname(os.path.abspath(__file__))
app_path = os.path.join(current_dir, "..", "app")
sys.path.append(app_path)

try:
    from preprocess import preprocess
except ImportError:
    print(f"Error: Could not find preprocess.py in {app_path}")
    sys.exit(1)


def extract_swords_icon(image_path, output_name="sprite_swords.png"):
    image = cv2.imread(image_path)
    if image is None:
        print(f"Error: Could not read the image at: {image_path}")
        return

    # Using the official function
    processed_img = preprocess(image)

    # Icon zone (Bulleit - R1)
    # x: 212, y: 212, w: 42, h: 42 (adjust if needed)
    x, y, w, h = 224, 512, 49, 46
    sprite = processed_img[y : y + h, x : x + w]

    cv2.imwrite(output_name, sprite)
    print(f"Success! Sprite saved: {os.path.abspath(output_name)}")


if __name__ == "__main__":
    # 2. Using a RAW STRING (r"...") to avoid Windows slash issues
    target_image = r"apps\ocr-service\tests\fixtures\polar_invasion\20260407T1500_001.jpg"

    # If you run the script from the project root, this path is correct.
    extract_swords_icon(target_image)
