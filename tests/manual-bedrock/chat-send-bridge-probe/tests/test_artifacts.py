from pathlib import Path
import json,re,zipfile,unittest
BASE=Path(__file__).resolve().parents[1]
class PackTests(unittest.TestCase):
 def test_all_json_parse(self):
  for p in (BASE/'resource_pack').rglob('*.json'):
   with self.subTest(p=str(p)):json.loads(p.read_text(encoding='utf-8'))
  for p in (BASE/'behavior_pack').rglob('*.json'):
   with self.subTest(p=str(p)):json.loads(p.read_text(encoding='utf-8'))
 def test_uuids(self):
  manifests=[json.loads((BASE/k/'manifest.json').read_text()) for k in ['resource_pack','behavior_pack']]
  ids=[]
  for m in manifests:
   ids.append(m['header']['uuid'])
   ids.extend(x['uuid'] for x in m['modules'])
  self.assertEqual(len(ids),len(set(ids)))
 def test_ui_defs(self):
  root=BASE/'resource_pack'
  defs=json.loads((root/'ui/_ui_defs.json').read_text())['ui_defs']
  self.assertEqual(len(defs),len(set(defs)))
  for d in defs:self.assertTrue((root/d).is_file(),d)
 def test_chat_not_drop(self):
  src='\n'.join(p.read_text() for p in (BASE/'resource_pack/ui').glob('*.json'))
  self.assertIn('button.send',src)
  self.assertIn('button.drop_one',src)
  self.assertIn('invui_chat_press.slot_grid',src)
  # drop_one is the one-click alternative to the manually entered chat notification.
  self.assertNotIn('button.container_take_all_place_all',src)
  self.assertIn('InvUI Chat Probe',src)
  self.assertIn('"namespace": "data_driven_container"',src)
  self.assertIn('"namespace": "pocket_containers"',src)
 def test_script(self):
  src=(BASE/'behavior_pack/scripts/main.js').read_text()
  for term in ['world.virtualContainerManager','virtualContainerClose','virtualContainerItemChange','world.beforeEvents.chatSend','event.cancel=true','sessionId','generation','sequence','slot']:
   self.assertIn(term,src)
  self.assertNotIn('ActionFormData',src)
 def test_output_zip(self):
  for fname in ['InvUI_VirtualContainer_Chat_RP_Probe.mcpack','InvUI_VirtualContainer_Chat_Probe.mcaddon','InvUI_VirtualContainer_Chat_Probe_Source.zip']:
   p=BASE.parent/fname
   self.assertTrue(zipfile.is_zipfile(p),str(p))
   with zipfile.ZipFile(p) as z:self.assertIsNone(z.testzip())
if __name__=='__main__':unittest.main()
