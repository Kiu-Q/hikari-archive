"""Return the same Japanese features the original editor uses."""

import io
import json
from pathlib import Path
import socket
import struct
import sys

import numpy as np
import torch
from style_bert_vits2.constants import Languages
from style_bert_vits2.models.hyper_parameters import HyperParameters
from style_bert_vits2.models.infer import get_text
from style_bert_vits2.nlp import bert_models
from style_bert_vits2.nlp.japanese import pyopenjtalk_worker
from style_bert_vits2.nlp.japanese.g2p_utils import g2kata_tone, kata_tone2phone_tone
from style_bert_vits2.nlp.japanese.normalizer import normalize_text


def main():
    model_config = Path(sys.argv[1])
    hps = HyperParameters.load_from_json(model_config)
    torch.set_num_threads(4)
    dictionary = Path("dict_data/user.dic")
    if dictionary.is_file():
        pyopenjtalk_worker.update_global_jtalk_with_user_dict(str(dictionary.resolve()))
    bert_models.load_model(Languages.JP)
    bert_models.load_tokenizer(Languages.JP)
    with socket.socket(fileno=int(sys.argv[2])) as peer, peer.makefile("rb") as stream:
        while header := stream.read(4):
            size = struct.unpack("!I", header)[0]
            text = json.loads(stream.read(size))
            try:
                text = normalize_text(text)
                tone = [value for _, value in kata_tone2phone_tone(g2kata_tone(text))]
                with torch.inference_mode():
                    _, bert, _, phones, tones, lang = get_text(
                        text, Languages.JP, hps, "cpu", given_tone=tone,
                    )
                output = io.BytesIO()
                np.savez(output, phones=phones.numpy()[None], tones=tones.numpy()[None],
                         lang=lang.numpy()[None], bert=bert.numpy()[None])
                result = output.getvalue()
            except Exception as error:
                result = json.dumps({"error": str(error)}).encode()
            peer.sendall(struct.pack("!I", len(result)) + result)


if __name__ == "__main__":
    main()
