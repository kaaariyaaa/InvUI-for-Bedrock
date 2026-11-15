#!/usr/bin/env python3
"""Build standalone Bedrock RP and experimental VirtualContainer chat bridge test addon."""
from pathlib import Path
import json, zipfile, uuid
BASE=Path(__file__).resolve().parent
RP=BASE/'resource_pack'; BP=BASE/'behavior_pack'

def write(p, val):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(val,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

write(RP/'manifest.json', {
 'format_version':2,
 'header':{'name':'InvUI VirtualContainer Chat Bridge | Probe','description':'VirtualContainer + JSON UI button.send transport probe. Does not provide automatic per-slot click payload generation.','uuid':'6736d9ca-7f06-4510-b702-c752ad63ab39','version':[0,2,0],'min_engine_version':[1,26,70]},
 'modules':[{'type':'resources','uuid':'0fb2584d-f5e1-4187-a735-16cacde28b4d','version':[0,2,0]}],
 'metadata':{'authors':['InvUI for Bedrock integration'],'license':'MIT'}
})
write(BP/'manifest.json',{
 'format_version':2,
 'header':{'name':'InvUI VirtualContainer Chat Bridge | Test Harness','description':'VirtualContainer test screen with event-confirmed chat input receiving. Test harness, not library replacement.','uuid':'b48b557b-8c1a-475a-ae8b-30a47cbc0bda','version':[0,2,0],'min_engine_version':[1,26,70]},
 'modules':[{'type':'script','language':'javascript','uuid':'155f6a9d-3428-418e-a4b5-aae228c76bd4','entry':'scripts/main.js','version':[0,2,0]}],
 'dependencies':[{'module_name':'@minecraft/server','version':'2.13.0-beta'},{'uuid':'6736d9ca-7f06-4510-b702-c752ad63ab39','version':[0,2,0]}],
 'metadata':{'authors':['InvUI for Bedrock integration'],'license':'MIT'}
})
write(RP/'ui/_ui_defs.json',{'ui_defs':['ui/invui_chat_transport.json','ui/invui_chat_desktop_attach.json','ui/invui_chat_pocket_attach.json','ui/invui_chat_slot_press.json']})

# UI control transplanted from the documented common.text_edit_box + chat.send button mechanisms.
# IMPORTANT: we explicitly avoid claiming those chat bindings apply to ChestScreenController.
button={
 'type':'button','size':[72,18],'layer':113,'focus_enabled':True,
 'default_control':'default','hover_control':'hover','pressed_control':'pressed',
 '$pressed_button_name':'button.send',
 'button_mappings':[
  {'from_button_id':'button.menu_select','to_button_id':'$pressed_button_name','mapping_type':'pressed'},
  {'from_button_id':'button.menu_ok','to_button_id':'$pressed_button_name','mapping_type':'focused'},
  {'from_button_id':'button.controller_select','to_button_id':'$pressed_button_name','mapping_type':'pressed'}
 ],
 'controls':[
  {'default':{'type':'image','texture':'textures/ui/button_borderless_light','size':['100%','100%']}},
  {'hover':{'type':'image','texture':'textures/ui/button_borderless_lighthover','size':['100%','100%']}},
  {'pressed':{'type':'image','texture':'textures/ui/button_borderless_lightpressed','size':['100%','100%']}},
  {'button_text':{'type':'label','text':'SEND','size':['100%','100%'],'text_alignment':'center','color':[1,1,1,1],'layer':2}}
 ]
}
write(RP/'ui/invui_chat_transport.json', {
 'namespace':'invui_chat',
 'bridge_overlay':{
  'type':'panel','size':['100%','100%'],'layer':105,
  # Exact title equality is a best-effort gate; validate on game before using it near other packs.
  'bindings':[{'binding_type':'view','source_property_name':"($container_title = 'InvUI Chat Probe')",'target_property_name':'#visible'}],
  'controls':[{'bridge_toolbar@invui_chat.bridge_toolbar':{'anchor_from':'top_left','anchor_to':'top_left','offset':[0,-52]}}]
 },
 'bridge_toolbar':{'type':'panel','size':[176,49],'layer':110,'controls':[
   {'status':{'type':'label','text':'InvUI CHAT INPUT','anchor_from':'top_left','anchor_to':'top_left','offset':[1,0],'size':[166,11],'color':[0.6,0.95,0.87,1],'font_type':'smooth','layer':111}},
   {'message_box@invui_chat.chat_message_box':{'anchor_from':'top_left','anchor_to':'top_left','offset':[0,12]}},
   {'send@invui_chat.send_button':{'anchor_from':'top_left','anchor_to':'top_left','offset':[100,12]}},
   {'help':{'type':'label','text':'Enter !invui:session:g:slot:seq','anchor_from':'top_left','anchor_to':'top_left','offset':[1,35],'size':[172,10],'color':[0.85,0.85,0.85,1],'layer':111}}
 ]},
 'chat_message_box@common.text_edit_box':{
    'layer':112,'size':[98,18],'max_length':130,'always_listening':True,
    '$focus_id':'invui_chat_bridge_box',
    '$text_box_name':'#message_text_box',
    '$text_edit_box_content_binding_name':'#message_text_box_content',
    '$place_holder_text':'!invui:...'
 },
 'send_button':button
})
# A one-click desktop overlay routes a slot's input to the native drop-one action.
# The Script API after-event checks disposable transport stack changes and dispatches.
write(RP/'ui/invui_chat_slot_press.json', {
 'namespace':'invui_chat_press',
 'slot_grid':{
  'type':'grid','grid_rescaling_type':'horizontal','size':[162,'default'],
  'maximum_grid_items':'$container_size','collection_name':'container_items',
  'grid_item_template':'invui_chat_press.press_slot','$item_collection_name':'container_items',
  'bindings':[{'binding_type':'view','source_property_name':"($container_title = 'InvUI Chat Probe')",'target_property_name':'#visible'}]
 },
 'press_slot@common.container_slot_button_prototype': {
  'size':[18,18],'layer':150,'$item_collection_name':'container_items',
  'sound_name':'random.click','sound_volume':0.4,'sound_pitch':1.0,
  'button_mappings':[
   {'from_button_id':'button.menu_select','to_button_id':'button.drop_one','mapping_type':'pressed'},
   {'from_button_id':'button.menu_ok','to_button_id':'button.drop_one','mapping_type':'pressed'},
   {'from_button_id':'button.menu_secondary_select','to_button_id':'button.drop_one','mapping_type':'pressed'},
   {'from_button_id':'button.controller_select','to_button_id':'button.drop_one','mapping_type':'pressed'},
   {'from_button_id':'button.controller_secondary_select','to_button_id':'button.drop_one','mapping_type':'pressed'},
   {'to_button_id':'button.container_slot_hovered','mapping_type':'pressed'}
  ]
 }
})

# Both attach points reference Mojang's real 1.26.70 source definitions.
write(RP/'ui/invui_chat_desktop_attach.json', {
 'namespace':'data_driven_container',
 'desktop_panel':{'modifications':[{'array_name':'controls','operation':'insert_back','value':[{'invui_chat_desktop@invui_chat.bridge_overlay':{}}]}]},
 'panel_top_half':{'modifications':[{'array_name':'controls','operation':'insert_back','value':[{'invui_chat_slot_press_grid@invui_chat_press.slot_grid':{'anchor_from':'top_left','anchor_to':'top_left','offset':[7,10]}}]}]}
})
write(RP/'ui/invui_chat_pocket_attach.json', {
 'namespace':'pocket_containers',
 'data_driven_container_panel':{'modifications':[{'array_name':'controls','operation':'insert_back','value':[{'invui_chat_pocket@invui_chat.bridge_overlay':{}}]}]}
})

def zpack(out, parts):
 with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for folder,prefix in parts:
   for file in sorted(folder.rglob('*')):
    if file.is_file() and '__pycache__' not in file.parts:
     rel=file.relative_to(folder)
     z.write(file, str(Path(prefix)/rel) if prefix else str(rel))

out=BASE.parent
zpack(out/'InvUI_VirtualContainer_Chat_RP_Probe.mcpack',[(RP,'')])
zpack(out/'InvUI_VirtualContainer_Chat_Probe.mcaddon',[(RP,'InvUI_Chat_Resource_Pack'),(BP,'InvUI_Chat_Behavior_Pack')])
zpack(out/'InvUI_VirtualContainer_Chat_Probe_Source.zip',[(BASE,'InvUI_VirtualContainer_Chat_Probe')])
for p in [out/'InvUI_VirtualContainer_Chat_RP_Probe.mcpack',out/'InvUI_VirtualContainer_Chat_Probe.mcaddon',out/'InvUI_VirtualContainer_Chat_Probe_Source.zip']:
 print(p,p.stat().st_size)
