import os
import sys

import cv2

# 1. On ajoute le chemin vers le dossier 'app' pour que Python trouve preprocess.py
# On remonte d'un niveau depuis 'tools' pour atteindre la racine de 'ocr-service' puis 'app'
current_dir = os.path.dirname(os.path.abspath(__file__))
app_path = os.path.join(current_dir, "..", "app")
sys.path.append(app_path)

try:
    from preprocess import preprocess
except ImportError:
    print(f"Erreur : Impossible de trouver preprocess.py dans {app_path}")
    sys.exit(1)


def extract_swords_icon(image_path, output_name="sprite_swords.png"):
    image = cv2.imread(image_path)
    if image is None:
        print(f"Erreur : Impossible de lire l'image à l'emplacement : {image_path}")
        return

    # Utilisation de ta fonction officielle
    processed_img = preprocess(image)

    # Zone de l'icône (Bulleit - R1)
    # x: 212, y: 212, w: 42, h: 42 (ajuste si besoin)
    x, y, w, h = 224, 512, 49, 46
    sprite = processed_img[y : y + h, x : x + w]

    cv2.imwrite(output_name, sprite)
    print(f"Succès ! Sprite sauvegardé : {os.path.abspath(output_name)}")


if __name__ == "__main__":
    # 2. Utilisation d'une RAW STRING (r"...") pour éviter les problèmes de slashs Windows
    target_image = r"apps\ocr-service\tests\fixtures\polar_invasion\20260407T1500_001.jpg"

    # Si tu lances le script depuis la racine du projet, ce chemin est correct.
    extract_swords_icon(target_image)
